import { describe, expect, test } from "bun:test";
import {
  PhaseGenerationError,
  buildPhaseDescription,
  parsePhaseHeading,
  slugify,
  validateGeneratedGraph,
} from "./phase-generation";
import { PhaseGraphValidationError } from "./phase-graph";
import { PhaseDocumentValidationError } from "./phase-document";
import type { PhaseDocument } from "./phase-document";

const EM_DASH = String.fromCharCode(0x2014);

function validDocument(overrides: Partial<PhaseDocument>): PhaseDocument {
  return {
    id: "a",
    deps: [],
    agentRole: "coder",
    description: "desc",
    tasks: ["do it"],
    doneWhen: [{ kind: "executable", description: "pass", command: "bun test" }],
    knowledge: [],
    ...overrides,
  };
}

describe("slugify", () => {
  test("collapses spaces and symbols into single dashes", () => {
    expect(slugify("from-spec + converter")).toBe("from-spec-converter");
    expect(slugify("index & recall")).toBe("index-recall");
    expect(slugify("MCP surface")).toBe("mcp-surface");
  });

  test("rejects a label that yields no slug characters", () => {
    expect(() => slugify("")).toThrow(PhaseGenerationError);
    expect(() => slugify(EM_DASH)).toThrow(PhaseGenerationError);
  });
});

describe("parsePhaseHeading", () => {
  test("splits a level-3 heading into number, slug id and title", () => {
    expect(
      parsePhaseHeading(`### Phase 5: from-spec + converter ${EM_DASH} gen and migration`),
    ).toEqual({ number: 5, id: "from-spec-converter", title: "gen and migration" });
  });

  test("parses a level-1 heading identically", () => {
    expect(
      parsePhaseHeading(`# Phase 5: from-spec + converter ${EM_DASH} gen and migration`),
    ).toEqual({ number: 5, id: "from-spec-converter", title: "gen and migration" });
  });

  test("splits only on the first separator so the title keeps later ones", () => {
    expect(parsePhaseHeading(`## Phase 2: gate-runner ${EM_DASH} run ${EM_DASH} exit codes`)).toEqual(
      { number: 2, id: "gate-runner", title: `run ${EM_DASH} exit codes` },
    );
  });

  test("treats a separator-less remainder as an empty title", () => {
    expect(parsePhaseHeading("## Phase 5: from-spec-converter")).toEqual({
      number: 5,
      id: "from-spec-converter",
      title: "",
    });
  });

  test("returns null for non-phase headings and bullets", () => {
    expect(parsePhaseHeading("## Goal")).toBeNull();
    expect(parsePhaseHeading("- bullet")).toBeNull();
  });

  test("throws when the heading label cannot be slugified", () => {
    expect(() => parsePhaseHeading(`### Phase 1: !!! ${EM_DASH} title`)).toThrow(
      PhaseGenerationError,
    );
  });
});

describe("buildPhaseDescription", () => {
  test("joins a title and prose with a blank line", () => {
    expect(buildPhaseDescription("the title", "the prose")).toBe("the title\n\nthe prose");
  });

  test("trims surrounding blank lines from each part before joining", () => {
    expect(buildPhaseDescription("the title", "\n\nthe prose\n")).toBe("the title\n\nthe prose");
  });

  test("drops an empty part instead of leaving a leading or trailing blank line", () => {
    expect(buildPhaseDescription("", "only prose")).toBe("only prose");
    expect(buildPhaseDescription("only title", "")).toBe("only title");
  });

  test("produces a description the schema accepts", () => {
    const description = buildPhaseDescription("the title", "\n\nthe prose\n");
    expect(() => validateGeneratedGraph([validDocument({ description })])).not.toThrow();
  });
});

describe("validateGeneratedGraph", () => {
  test("returns a graph keyed by phase id for a valid chain", () => {
    const first = validDocument({ id: "first" });
    const second = validDocument({ id: "second", deps: ["first"] });
    const graph = validateGeneratedGraph([first, second]);
    expect(Object.keys(graph.phases).sort()).toEqual(["first", "second"]);
  });

  test("propagates a graph integrity error on a duplicate id", () => {
    const first = validDocument({ id: "same" });
    const second = validDocument({ id: "same", deps: [] });
    expect(() => validateGeneratedGraph([first, second])).toThrow(PhaseGraphValidationError);
  });

  test("propagates a field grammar error on an invalid document", () => {
    expect(() => validateGeneratedGraph([validDocument({ tasks: [] })])).toThrow(
      PhaseDocumentValidationError,
    );
  });
});
