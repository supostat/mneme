import { test, expect, describe } from "bun:test";
import {
  fuseAndFill,
  estimateTokens,
  compareIds,
  DEFAULT_FUSION_PARAMS,
  RRF_K,
  TOKEN_BYTES,
} from "./fusion";
import type { FusionInput, FusionParams } from "./fusion";

// Every expected value below is written as the arithmetic definition (never by calling fuseAndFill),
// so the assertions independently pin the RRF + budget contract rather than echoing the code.

function input(overrides: Partial<FusionInput> & { id: string }): FusionInput {
  return { ftsRank: null, vectorRank: null, stalenessBoost: 0, tokenEst: null, ...overrides };
}

function withParams(overrides: Partial<FusionParams>): FusionParams {
  return { ...DEFAULT_FUSION_PARAMS, ...overrides };
}

describe("fusion constants", () => {
  test("RRF_K is 60 and TOKEN_BYTES is 4", () => {
    expect(RRF_K).toBe(60);
    expect(TOKEN_BYTES).toBe(4);
  });

  test("the default params are the byte-identity weights", () => {
    expect(DEFAULT_FUSION_PARAMS).toEqual({ rrfK: 60, ftsWeight: 1, vectorWeight: 1, stalenessWeight: 1 });
  });
});

describe("fuseAndFill scoring and budget", () => {
  test("ranks by descending score, exposes rrf and score, and fills greedily", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "a", ftsRank: 1, vectorRank: 1, tokenEst: 10 }),
        input({ id: "b", ftsRank: 2, tokenEst: 10 }),
        input({ id: "c", vectorRank: 3, tokenEst: 10 }),
      ],
      DEFAULT_FUSION_PARAMS,
      25,
    );

    expect(decisions.map((decision) => decision.id)).toEqual(["a", "b", "c"]);
    expect(decisions[0]!.rrf).toBe(1 / 61 + 1 / 61);
    expect(decisions[0]!.score).toBe(1 / 61 + 1 / 61);
    expect(decisions[1]!.rrf).toBe(1 / 62);
    expect(decisions[2]!.rrf).toBe(1 / 63);
    expect(decisions.map((decision) => decision.inBudget)).toEqual([true, true, false]);
  });

  test("a staleness boost is added after the RRF sum, preserving addition order", () => {
    const decisions = fuseAndFill(
      [input({ id: "a", ftsRank: 1, vectorRank: 2, stalenessBoost: -0.5, tokenEst: 1 })],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    expect(decisions[0]!.rrf).toBe(1 / 61 + 1 / 62);
    expect(decisions[0]!.score).toBe(1 / 61 + 1 / 62 + -0.5);
  });

  test("breaks score ties by ascending id regardless of input order", () => {
    const decisions = fuseAndFill(
      [input({ id: "c", ftsRank: 2, tokenEst: 5 }), input({ id: "b", ftsRank: 2, tokenEst: 5 })],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    expect(decisions.map((decision) => decision.id)).toEqual(["b", "c"]);
    expect(decisions[0]!.score).toBe(decisions[1]!.score);
  });

  test("the ranked result is independent of input order", () => {
    const forward = fuseAndFill(
      [
        input({ id: "a", ftsRank: 1, tokenEst: 1 }),
        input({ id: "b", ftsRank: 2, tokenEst: 1 }),
        input({ id: "c", ftsRank: 3, tokenEst: 1 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );
    const scrambled = fuseAndFill(
      [
        input({ id: "c", ftsRank: 3, tokenEst: 1 }),
        input({ id: "a", ftsRank: 1, tokenEst: 1 }),
        input({ id: "b", ftsRank: 2, tokenEst: 1 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    expect(scrambled.map((decision) => decision.id)).toEqual(["a", "b", "c"]);
    expect(scrambled.map((decision) => decision.id)).toEqual(forward.map((decision) => decision.id));
  });

  test("a note that exactly fills the remaining budget is in and the next is out", () => {
    const inputs = [
      input({ id: "a", ftsRank: 1, tokenEst: 10 }),
      input({ id: "b", ftsRank: 2, tokenEst: 1 }),
    ];

    const tight = fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 10);
    expect(tight.map((decision) => decision.inBudget)).toEqual([true, false]);

    const roomy = fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 11);
    expect(roomy.map((decision) => decision.inBudget)).toEqual([true, true]);
  });

  test("a null token estimate is skipped without consuming budget or halting the fill", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "a", ftsRank: 1, tokenEst: null }),
        input({ id: "b", ftsRank: 2, tokenEst: 5 }),
        input({ id: "c", ftsRank: 3, tokenEst: 5 }),
      ],
      DEFAULT_FUSION_PARAMS,
      10,
    );

    expect(decisions.map((decision) => decision.inBudget)).toEqual([false, true, true]);
  });

  test("an over-budget top note is skipped and a smaller lower-ranked note is still admitted", () => {
    const decisions = fuseAndFill(
      [input({ id: "a", ftsRank: 1, tokenEst: 100 }), input({ id: "b", ftsRank: 2, tokenEst: 5 })],
      DEFAULT_FUSION_PARAMS,
      10,
    );

    expect(decisions.map((decision) => decision.inBudget)).toEqual([false, true]);
  });
});

describe("fuseAndFill alternative parameters", () => {
  test("a smaller rrfK reorders a strong single-channel note above a two-channel note", () => {
    const inputs = [
      input({ id: "p", ftsRank: 1, tokenEst: 1 }),
      input({ id: "q", ftsRank: 3, vectorRank: 3, tokenEst: 1 }),
    ];

    // Default k=60: q (1/63 + 1/63) outscores p (1/61).
    expect(fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 100).map((decision) => decision.id)).toEqual(["q", "p"]);
    // k=0: p (1/1) outscores q (1/3 + 1/3).
    expect(fuseAndFill(inputs, withParams({ rrfK: 0 }), 100).map((decision) => decision.id)).toEqual(["p", "q"]);
  });

  test("a zero fts weight collapses to a pure vector ranking", () => {
    const inputs = [
      input({ id: "m", ftsRank: 1, tokenEst: 1 }),
      input({ id: "n", vectorRank: 1, tokenEst: 1 }),
    ];

    // Default: both score 1/61, tie broken by id.
    expect(fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 100).map((decision) => decision.id)).toEqual(["m", "n"]);
    // ftsWeight 0: m scores 0, n scores 1/61.
    expect(fuseAndFill(inputs, withParams({ ftsWeight: 0 }), 100).map((decision) => decision.id)).toEqual(["n", "m"]);
  });

  test("a zero staleness weight neutralizes a dead-anchor sink", () => {
    const inputs = [
      input({ id: "x", ftsRank: 1, vectorRank: 1, stalenessBoost: -0.5, tokenEst: 5 }),
      input({ id: "y", ftsRank: 2, vectorRank: 2, stalenessBoost: 0, tokenEst: 5 }),
    ];

    // Default: x is sunk to (2/61 - 0.5), below y (2/62).
    expect(fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 100).map((decision) => decision.id)).toEqual(["y", "x"]);
    // stalenessWeight 0: x (2/61) rises above y (2/62).
    expect(fuseAndFill(inputs, withParams({ stalenessWeight: 0 }), 100).map((decision) => decision.id)).toEqual(["x", "y"]);
  });

  test("a smaller budget shrinks the admitted set", () => {
    const inputs = [
      input({ id: "a", ftsRank: 1, tokenEst: 5 }),
      input({ id: "b", ftsRank: 2, tokenEst: 5 }),
    ];

    const admitted = (budget: number): string[] =>
      fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, budget)
        .filter((decision) => decision.inBudget)
        .map((decision) => decision.id);

    expect(admitted(10)).toEqual(["a", "b"]);
    expect(admitted(5)).toEqual(["a"]);
    expect(admitted(4)).toEqual([]);
  });
});

describe("estimateTokens", () => {
  test("rounds the utf-8 byte length up to a whole token of four bytes", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("counts multi-byte characters by their encoded byte length", () => {
    // "é" is two utf-8 bytes, so it rounds up to one token.
    expect(estimateTokens("é")).toBe(1);
  });
});

describe("compareIds", () => {
  test("orders strings ascending and reports equality as zero", () => {
    expect(compareIds("a", "b")).toBe(-1);
    expect(compareIds("b", "a")).toBe(1);
    expect(compareIds("a", "a")).toBe(0);
  });
});
