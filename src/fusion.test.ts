import { test, expect, describe } from "bun:test";
import {
  fuseAndFill,
  estimateTokens,
  compareIds,
  DEAD_ANCHOR_SINK,
  DEFAULT_FUSION_PARAMS,
  RRF_K,
  TOKEN_BYTES,
} from "./fusion";
import type { FusionInput, FusionParams } from "./fusion";
import {
  DEAD_ANCHOR_SINK as STALENESS_DEAD_ANCHOR_SINK,
  DRIFT_PENALTY_CAP,
  KNOWN_ELSEWHERE_PENALTY,
  UNRESOLVED_BASE_PENALTY,
} from "./staleness";

// Every expected value below is written as the arithmetic definition (never by calling fuseAndFill),
// so the assertions independently pin the ranking + budget contract rather than echoing the code.

function input(overrides: Partial<FusionInput> & { id: string }): FusionInput {
  return { ftsRank: null, vectorRank: null, stalenessBoost: 0, tokenEst: null, ...overrides };
}

function withParams(overrides: Partial<FusionParams>): FusionParams {
  return { ...DEFAULT_FUSION_PARAMS, ...overrides };
}

function idsOf(decisions: ReturnType<typeof fuseAndFill>): string[] {
  return decisions.map((decision) => decision.id);
}

describe("fusion constants", () => {
  test("RRF_K is 60 and TOKEN_BYTES is 4", () => {
    expect(RRF_K).toBe(60);
    expect(TOKEN_BYTES).toBe(4);
  });

  test("the default params carry the channel weights only — staleness is a key, not a weight", () => {
    expect(DEFAULT_FUSION_PARAMS).toEqual({ rrfK: 60, ftsWeight: 1, vectorWeight: 1 });
  });

  test("the dead-anchor sink is -1 and staleness re-exports the very same value", () => {
    expect(DEAD_ANCHOR_SINK).toBe(-1);
    expect(STALENESS_DEAD_ANCHOR_SINK).toBe(DEAD_ANCHOR_SINK);
  });
});

describe("fuseAndFill ranking and budget", () => {
  test("ranks by descending rrf, exposes rrf without a score, and fills greedily", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "a", ftsRank: 1, vectorRank: 1, tokenEst: 10 }),
        input({ id: "b", ftsRank: 2, tokenEst: 10 }),
        input({ id: "c", vectorRank: 3, tokenEst: 10 }),
      ],
      DEFAULT_FUSION_PARAMS,
      25,
    );

    expect(idsOf(decisions)).toEqual(["a", "b", "c"]);
    expect(decisions[0]!.rrf).toBe(1 / 61 + 1 / 61);
    expect(decisions[1]!.rrf).toBe(1 / 62);
    expect(decisions[2]!.rrf).toBe(1 / 63);
    expect("score" in decisions[0]!).toBe(false);
    expect(decisions.map((decision) => decision.inBudget)).toEqual([true, true, false]);
  });

  test("drift never outranks relevance: a capped-drift note stays above a fresh, less relevant one", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "b", ftsRank: 2, stalenessBoost: 0, tokenEst: 1 }),
        input({ id: "a", ftsRank: 1, stalenessBoost: DRIFT_PENALTY_CAP, tokenEst: 1 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    // 1/61 > 1/62 decides; the -0.01 cap would have flipped them under an additive score.
    expect(idsOf(decisions)).toEqual(["a", "b"]);
    expect(decisions[0]!.rrf).toBe(1 / 61);
    expect(decisions[1]!.rrf).toBe(1 / 62);
  });

  test("an exact rrf tie is broken by less drift first: symmetric rank pairs tie exactly", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "a", ftsRank: 1, vectorRank: 4, stalenessBoost: -0.01, tokenEst: 1 }),
        input({ id: "b", ftsRank: 4, vectorRank: 1, stalenessBoost: -0.007, tokenEst: 1 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    // IEEE addition is commutative, so 1/61 + 1/64 and 1/64 + 1/61 are the same float.
    expect(decisions[0]!.rrf).toBe(1 / 61 + 1 / 64);
    expect(decisions[1]!.rrf).toBe(decisions[0]!.rrf);
    expect(idsOf(decisions)).toEqual(["b", "a"]);
  });

  test("a tie on rrf and on drift falls back to ascending id regardless of input order", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "c", ftsRank: 2, stalenessBoost: -0.003, tokenEst: 5 }),
        input({ id: "b", ftsRank: 2, stalenessBoost: -0.003, tokenEst: 5 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    expect(idsOf(decisions)).toEqual(["b", "c"]);
    expect(decisions[0]!.rrf).toBe(decisions[1]!.rrf);
  });

  test("a dead anchor sinks below every live candidate whatever its relevance; dead ones rank by rrf among themselves", () => {
    const decisions = fuseAndFill(
      [
        input({ id: "x", ftsRank: 1, vectorRank: 1, stalenessBoost: DEAD_ANCHOR_SINK, tokenEst: 5 }),
        input({ id: "w", ftsRank: 2, stalenessBoost: DEAD_ANCHOR_SINK, tokenEst: 5 }),
        input({ id: "y", ftsRank: 3, vectorRank: 3, stalenessBoost: 0, tokenEst: 5 }),
        input({ id: "z", ftsRank: 4, stalenessBoost: DRIFT_PENALTY_CAP, tokenEst: 5 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    // Live y and z first (2/63 above 1/64), then the dead x (2/61) above the dead w (1/62).
    expect(idsOf(decisions)).toEqual(["y", "z", "x", "w"]);
  });

  test("the parked and the base-less penalties are live-class values: relevance still ranks them", () => {
    const parked = fuseAndFill(
      [
        input({ id: "b", ftsRank: 2, stalenessBoost: 0, tokenEst: 1 }),
        input({ id: "a", ftsRank: 1, stalenessBoost: KNOWN_ELSEWHERE_PENALTY, tokenEst: 1 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );
    const baseless = fuseAndFill(
      [
        input({ id: "b", ftsRank: 2, stalenessBoost: 0, tokenEst: 1 }),
        input({ id: "a", ftsRank: 1, stalenessBoost: UNRESOLVED_BASE_PENALTY, tokenEst: 1 }),
      ],
      DEFAULT_FUSION_PARAMS,
      100,
    );

    expect(KNOWN_ELSEWHERE_PENALTY).toBeGreaterThan(DEAD_ANCHOR_SINK);
    expect(UNRESOLVED_BASE_PENALTY).toBeGreaterThan(DEAD_ANCHOR_SINK);
    expect(idsOf(parked)).toEqual(["a", "b"]);
    expect(idsOf(baseless)).toEqual(["a", "b"]);
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

    expect(idsOf(scrambled)).toEqual(["a", "b", "c"]);
    expect(idsOf(scrambled)).toEqual(idsOf(forward));
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
    expect(idsOf(fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 100))).toEqual(["q", "p"]);
    // k=0: p (1/1) outscores q (1/3 + 1/3).
    expect(idsOf(fuseAndFill(inputs, withParams({ rrfK: 0 }), 100))).toEqual(["p", "q"]);
  });

  test("a zero fts weight collapses to a pure vector ranking", () => {
    const inputs = [
      input({ id: "m", ftsRank: 1, tokenEst: 1 }),
      input({ id: "n", vectorRank: 1, tokenEst: 1 }),
    ];

    // Default: both score 1/61, tie broken by id.
    expect(idsOf(fuseAndFill(inputs, DEFAULT_FUSION_PARAMS, 100))).toEqual(["m", "n"]);
    // ftsWeight 0: m scores 0, n scores 1/61.
    expect(idsOf(fuseAndFill(inputs, withParams({ ftsWeight: 0 }), 100))).toEqual(["n", "m"]);
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
