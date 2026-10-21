import { describe, expect, test } from "bun:test";
import { MAX_BODY_CODE_POINTS } from "../note";
import {
  HARVEST_BODY_LIMIT_RULE,
  HARVEST_SOURCE,
  HarvestArtifactError,
  assertArtifactBodiesFit,
  rememberInputFrom,
} from "./harvest-artifacts";
import type { PhaseArtifact } from "./harvest-artifacts";

const LINE_SEPARATOR = String.fromCharCode(0x2028);

// Each kind's labels take a fixed share of the limit: the field that fills the rest is sized so the
// rendered body lands exactly on the limit, then one code point past it.
const KINDS: ReadonlyArray<{ prefix: number; artifact: (filler: string) => PhaseArtifact }> = [
  {
    prefix: 36,
    artifact: (filler) => ({ kind: "fixed_test", test: filler, failure: "", fix: "", anchors: ["src/a.ts"] }),
  },
  {
    prefix: 29,
    artifact: (filler) => ({ kind: "resolved_error", error: filler, resolution: "", anchors: ["src/a.ts"] }),
  },
  {
    prefix: 22,
    artifact: (filler) => ({ kind: "decision", decision: filler, rationale: "", anchors: ["src/a.ts"] }),
  },
];

describe("rememberInputFrom renders the fixed templates", () => {
  test("each kind maps to its note type and labelled body, staged as a harvest", () => {
    expect(
      rememberInputFrom({ kind: "fixed_test", test: "t", failure: "f", fix: "x", anchors: ["src/a.ts"] }),
    ).toEqual({
      type: "bugfix",
      body: "Fixed failing test: t\nFailure: f\nFix: x",
      anchors: ["src/a.ts"],
      source: HARVEST_SOURCE,
    });
    expect(
      rememberInputFrom({ kind: "resolved_error", error: "e", resolution: "r", anchors: ["src/a.ts"] }).body,
    ).toBe("Resolved error: e\nResolution: r");
    expect(
      rememberInputFrom({ kind: "decision", decision: "d", rationale: "r", anchors: ["src/a.ts"] }),
    ).toMatchObject({ type: "decision", body: "Decision: d\nRationale: r" });
  });
});

describe("assertArtifactBodiesFit", () => {
  for (const { prefix, artifact } of KINDS) {
    const kind = artifact("").kind;

    test(`a ${kind} body exactly at the limit is accepted and kept whole`, () => {
      const atLimit = artifact("x".repeat(MAX_BODY_CODE_POINTS - prefix));

      expect(() => assertArtifactBodiesFit([atLimit])).not.toThrow();
      expect([...rememberInputFrom(atLimit).body].length).toBe(MAX_BODY_CODE_POINTS);
    });

    test(`a ${kind} body one code point over is refused with its length, overflow and prefix`, () => {
      const overLimit = artifact("x".repeat(MAX_BODY_CODE_POINTS - prefix + 1));

      expect(() => assertArtifactBodiesFit([overLimit])).toThrow(
        `harvest artifact 1 (${kind}) renders to 1501 code points — 1 over the 1500 limit ` +
          `(the template prefix takes ${prefix}); nothing was staged`,
      );
    });
  }

  test("the limit counts code points, so astral characters are not charged twice", () => {
    const astral = String.fromCodePoint(0x1d306);
    const atLimit: PhaseArtifact = {
      kind: "decision",
      decision: astral.repeat(MAX_BODY_CODE_POINTS - 22),
      rationale: "",
      anchors: ["src/a.ts"],
    };

    expect(() => assertArtifactBodiesFit([atLimit])).not.toThrow();
  });

  test("foreign markup is refused with the offending token, naming the artifact's position", () => {
    const marked: PhaseArtifact = {
      kind: "decision",
      decision: "clean",
      rationale: `split${LINE_SEPARATOR}line`,
      anchors: ["src/a.ts"],
    };
    const clean: PhaseArtifact = {
      kind: "decision",
      decision: "fine",
      rationale: "fine",
      anchors: ["src/a.ts"],
    };

    expect(() => assertArtifactBodiesFit([clean, marked])).toThrow(HarvestArtifactError);
    expect(() => assertArtifactBodiesFit([clean, marked])).toThrow(
      "harvest artifact 2 (decision) contains foreign tool/protocol markup: U+2028; nothing was staged",
    );
  });

  test("the rule names the limit an agent must respect before it submits", () => {
    expect(HARVEST_BODY_LIMIT_RULE).toBe(
      "each harvest artifact's body — its template prefix included — must fit 1500 code points; " +
        "an artifact over it refuses the whole harvest and nothing is staged",
    );
  });
});
