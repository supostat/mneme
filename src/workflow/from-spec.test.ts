import { describe, expect, test } from "bun:test";
import { phaseDocumentsFromSpec } from "./from-spec";
import { PhaseGenerationError } from "./phase-generation";
import { PhaseGraphValidationError, buildPhaseGraph } from "./phase-graph";
import { parsePhaseDocument, serializePhaseDocument } from "./phase-document";

const EM_DASH = String.fromCharCode(0x2014);
const EXECUTABLE_MARKER = "**Done when (EXECUTABLE):**";

function executableBlock(command: string, description: string): string {
  return [EXECUTABLE_MARKER, "```", command, "```", description].join("\n");
}

function gameplanSpec(...phaseBlocks: string[]): string {
  return ["# Gameplan", "", ...phaseBlocks].join("\n");
}

function phaseBlock(heading: string, tasks: string[], doneWhenBlock: string): string {
  return [heading, "", ...tasks.map((task) => `- [ ] ${task}`), "", doneWhenBlock, ""].join("\n");
}

describe("phaseDocumentsFromSpec happy path", () => {
  const specText = gameplanSpec(
    phaseBlock(
      `### Phase 1: alpha core ${EM_DASH} first title`,
      ["do first", "do second"],
      [
        "**Done when:** alpha is green.",
        "",
        executableBlock("bun test src/alpha.test.ts", "alpha suite is green."),
      ].join("\n"),
    ),
    phaseBlock(
      `### Phase 2: beta engine ${EM_DASH} second title`,
      ["build beta"],
      executableBlock("bun test src/beta.test.ts", "beta suite is green."),
    ),
    phaseBlock(
      `### Phase 3: gamma surface ${EM_DASH} third title`,
      ["ship gamma"],
      executableBlock("bun test src/gamma.test.ts", "gamma suite is green."),
    ),
  );

  test("produces one slugified document per phase", () => {
    const documents = phaseDocumentsFromSpec(specText);
    expect(documents.map((document) => document.id)).toEqual(["alpha-core", "beta-engine", "gamma-surface"]);
  });

  test("chains dependencies strictly by listing order", () => {
    const documents = phaseDocumentsFromSpec(specText);
    expect(documents.map((document) => document.deps)).toEqual([[], ["alpha-core"], ["beta-engine"]]);
  });

  test("preserves the tasks of each phase", () => {
    const documents = phaseDocumentsFromSpec(specText);
    expect(documents[0]?.tasks).toEqual(["do first", "do second"]);
    expect(documents[1]?.tasks).toEqual(["build beta"]);
  });

  test("extracts the executable done-when of each phase", () => {
    const documents = phaseDocumentsFromSpec(specText);
    expect(documents[0]?.doneWhen).toEqual([
      { kind: "executable", description: "alpha suite is green.", command: "bun test src/alpha.test.ts" },
    ]);
    expect(documents[1]?.doneWhen).toEqual([
      { kind: "executable", description: "beta suite is green.", command: "bun test src/beta.test.ts" },
    ]);
  });

  test("carries the phase title and acceptance prose into the description", () => {
    const [firstDocument] = phaseDocumentsFromSpec(specText);
    expect(firstDocument?.description).toContain("first title");
    expect(firstDocument?.description).toContain("alpha is green.");
  });

  test("keeps the phase description free of the criterion prose", () => {
    const [firstDocument] = phaseDocumentsFromSpec(specText);
    expect(firstDocument?.description).not.toContain("alpha suite is green.");
  });

  test("builds a valid phase graph and round-trips through the serializer", () => {
    const documents = phaseDocumentsFromSpec(specText);
    expect(() => buildPhaseGraph(documents)).not.toThrow();
    for (const document of documents) {
      expect(parsePhaseDocument(serializePhaseDocument(document))).toEqual(document);
    }
  });

  test("bounds extraction to the # Gameplan section", () => {
    const specWithTrailingSection = `${specText}\n# Appendix\n\n### Phase 9: leaked ${EM_DASH} nope\n\n- [ ] ignored\n`;
    expect(phaseDocumentsFromSpec(specWithTrailingSection).map((document) => document.id)).toEqual([
      "alpha-core",
      "beta-engine",
      "gamma-surface",
    ]);
  });
});

// A dedicated, synthetic sample spec that exists ONLY for this test. It is deliberately
// unrelated to the project's evolving docs/V2-SPEC.md, so edits to the real spec can never
// break this test -- only a regression in from-spec can. Kept inline (no pre-baked fixture
// file) per the repo convention that test fixtures are built at runtime; the em-dash is
// composed via EM_DASH so this source file stays pure ASCII.
const SAMPLE_GAMEPLAN_SPEC = [
  "# Overview",
  "",
  "Prose above the gameplan that the parser must ignore.",
  "",
  "# Gameplan",
  "",
  "A sequential build plan that exists only for from-spec's test.",
  "",
  `### Phase 1: ingest source ${EM_DASH} read the raw input`,
  "",
  "- [ ] open the input",
  "- [ ] validate the header",
  "",
  "**Done when:** the raw input parses.",
  "",
  EXECUTABLE_MARKER,
  "```",
  "bun test src/ingest.test.ts",
  "```",
  "the ingest suite is green.",
  "",
  `### Phase 2: normalize records ${EM_DASH} canonical form`,
  "",
  "- [ ] map the fields",
  "",
  "**Done when:** records reach canonical form.",
  "",
  EXECUTABLE_MARKER,
  "```",
  "bun test src/normalize.test.ts",
  "```",
  "the normalize suite is green.",
  "",
  `### Phase 3: index store ${EM_DASH} build the searchable index`,
  "",
  "- [ ] write the index",
  "",
  "**Done when:** the index round-trips.",
  "",
  EXECUTABLE_MARKER,
  "```",
  "bun test src/index-store.test.ts",
  "```",
  "the index suite is green.",
  "",
  `### Phase 4: query surface ${EM_DASH} expose retrieval`,
  "",
  "- [ ] wire the endpoint",
  "",
  "**Done when:** a query returns results.",
  "",
  EXECUTABLE_MARKER,
  "```",
  "bun test src/query.test.ts",
  "```",
  "the query suite is green.",
  "",
  "# Appendix",
  "",
  `### Phase 9: ignored ${EM_DASH} sits outside the gameplan`,
  "",
  "- [ ] must never appear",
  "",
].join("\n");

describe("phaseDocumentsFromSpec against a dedicated sample spec", () => {
  test("derives a sequential phase chain from the sample gameplan", () => {
    const documents = phaseDocumentsFromSpec(SAMPLE_GAMEPLAN_SPEC);
    expect(documents.map((document) => document.id)).toEqual([
      "ingest-source",
      "normalize-records",
      "index-store",
      "query-surface",
    ]);
    expect(documents.map((document) => document.deps)).toEqual([
      [],
      ["ingest-source"],
      ["normalize-records"],
      ["index-store"],
    ]);
  });

  test("ignores phase headings outside the # Gameplan section", () => {
    const documents = phaseDocumentsFromSpec(SAMPLE_GAMEPLAN_SPEC);
    expect(documents.map((document) => document.id)).not.toContain("ignored");
  });

  test("emits an executable done-when for every phase and builds a valid graph", () => {
    const documents = phaseDocumentsFromSpec(SAMPLE_GAMEPLAN_SPEC);
    for (const document of documents) {
      expect(document.doneWhen.length).toBeGreaterThan(0);
      expect(document.doneWhen.every((criterion) => criterion.kind === "executable")).toBe(true);
    }
    expect(() => buildPhaseGraph(documents)).not.toThrow();
  });
});

describe("phaseDocumentsFromSpec executable extraction", () => {
  test("reads the fenced command and prose, not the default suite", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/example.test.ts", "example suite is green."),
      ),
    );
    const [document] = phaseDocumentsFromSpec(specText);
    expect(document?.doneWhen).toEqual([
      {
        kind: "executable",
        description: "example suite is green.",
        command: "bun test src/example.test.ts",
      },
    ]);
    const [criterion] = document?.doneWhen ?? [];
    expect(criterion?.kind === "executable" ? criterion.command : "").not.toBe("bun test");
  });
});

describe("phaseDocumentsFromSpec multiple criteria", () => {
  const specText = gameplanSpec(
    phaseBlock(
      `### Phase 1: alpha ${EM_DASH} one`,
      ["a"],
      [
        EXECUTABLE_MARKER,
        "```",
        "bun test src/one.test.ts",
        "```",
        "first check passes.",
        "```",
        "bun test src/two.test.ts",
        "```",
        "second check passes.",
      ].join("\n"),
    ),
  );

  test("collects every adjacent fence-first record in order", () => {
    const [document] = phaseDocumentsFromSpec(specText);
    expect(document?.doneWhen).toEqual([
      { kind: "executable", description: "first check passes.", command: "bun test src/one.test.ts" },
      { kind: "executable", description: "second check passes.", command: "bun test src/two.test.ts" },
    ]);
  });

  test("stops criterion prose at the next phase heading without swallowing it", () => {
    const specWithAdjacentPhases = [
      "# Gameplan",
      "",
      `### Phase 1: alpha ${EM_DASH} one`,
      "",
      "- [ ] a",
      "",
      EXECUTABLE_MARKER,
      "```",
      "bun test src/a.test.ts",
      "```",
      "alpha done.",
      `### Phase 2: beta ${EM_DASH} two`,
      "",
      "- [ ] b",
      "",
      executableBlock("bun test src/b.test.ts", "beta done."),
      "",
    ].join("\n");
    const documents = phaseDocumentsFromSpec(specWithAdjacentPhases);
    expect(documents.map((document) => document.id)).toEqual(["alpha", "beta"]);
    expect(documents[0]?.doneWhen).toEqual([
      { kind: "executable", description: "alpha done.", command: "bun test src/a.test.ts" },
    ]);
  });

  test("joins a multi-line criterion prose into a single-line description", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        [EXECUTABLE_MARKER, "```", "bun test src/a.test.ts", "```", "first line", "second line"].join("\n"),
      ),
    );
    const [document] = phaseDocumentsFromSpec(specText);
    expect(document?.doneWhen).toEqual([
      { kind: "executable", description: "first line second line", command: "bun test src/a.test.ts" },
    ]);
  });
});

describe("phaseDocumentsFromSpec policy A", () => {
  test("throws when a phase has no done-when at all", () => {
    const specText = gameplanSpec(
      [`### Phase 1: alpha ${EM_DASH} one`, "", "- [ ] a", ""].join("\n"),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws when a phase carries only the prose done-when line", () => {
    const specText = gameplanSpec(
      phaseBlock(`### Phase 1: alpha ${EM_DASH} one`, ["a"], "**Done when:** alpha is green."),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("round-trips a multi-criteria document through the serializer", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        [
          EXECUTABLE_MARKER,
          "```",
          "bun test src/one.test.ts",
          "```",
          "first check passes.",
          "```",
          "bun test src/two.test.ts",
          "```",
          "second check passes.",
        ].join("\n"),
      ),
    );
    const documents = phaseDocumentsFromSpec(specText);
    expect(documents[0]?.doneWhen).toHaveLength(2);
    for (const document of documents) {
      expect(parsePhaseDocument(serializePhaseDocument(document))).toEqual(document);
    }
  });
});

describe("phaseDocumentsFromSpec structural rejections", () => {
  test("throws on an unclosed fenced command", () => {
    const specText = gameplanSpec(
      [
        `### Phase 1: alpha ${EM_DASH} one`,
        "",
        "- [ ] a",
        "",
        EXECUTABLE_MARKER,
        "```",
        "bun test src/a.test.ts",
        "some prose.",
      ].join("\n"),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws on a two-line fenced command", () => {
    const specText = gameplanSpec(
      [
        `### Phase 1: alpha ${EM_DASH} one`,
        "",
        "- [ ] a",
        "",
        EXECUTABLE_MARKER,
        "```",
        "bun test src/a.test.ts",
        "bun test src/b.test.ts",
        "```",
        "some prose.",
        "",
      ].join("\n"),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws on a fence-first record with no trailing prose", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        [EXECUTABLE_MARKER, "```", "bun test src/a.test.ts", "```"].join("\n"),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws when the executable marker is not immediately followed by a fence", () => {
    const specText = gameplanSpec(
      [
        `### Phase 1: alpha ${EM_DASH} one`,
        "",
        "- [ ] a",
        "",
        EXECUTABLE_MARKER,
        "",
        "```",
        "bun test src/a.test.ts",
        "```",
        "some prose.",
      ].join("\n"),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws when a blank line separates two criteria rather than dropping the second", () => {
    const specText = gameplanSpec(
      [
        `### Phase 1: alpha ${EM_DASH} one`,
        "",
        "- [ ] a",
        "",
        EXECUTABLE_MARKER,
        "```",
        "bun test src/one.test.ts",
        "```",
        "first check passes.",
        "",
        "```",
        "bun test src/two.test.ts",
        "```",
        "second check passes.",
      ].join("\n"),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });
});

describe("phaseDocumentsFromSpec knowledge extraction", () => {
  const knowledgeBullets = ["anchors bind notes to commits", "staleness is deterministic"];
  const specWithKnowledge = [
    "# Knowledge",
    "",
    ...knowledgeBullets.map((bullet) => `- ${bullet}`),
    "",
    gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/a.test.ts", "alpha done."),
      ),
      phaseBlock(
        `### Phase 2: beta ${EM_DASH} two`,
        ["b"],
        executableBlock("bun test src/b.test.ts", "beta done."),
      ),
    ),
  ].join("\n");

  test("carries the whole # Knowledge section into every generated phase", () => {
    const documents = phaseDocumentsFromSpec(specWithKnowledge);
    expect(documents).toHaveLength(2);
    for (const document of documents) {
      expect(document.knowledge).toEqual(knowledgeBullets);
    }
  });

  test("a knowledge-bearing phase round-trips through the serializer", () => {
    for (const document of phaseDocumentsFromSpec(specWithKnowledge)) {
      expect(parsePhaseDocument(serializePhaseDocument(document))).toEqual(document);
    }
  });

  test("a spec without a # Knowledge section leaves every phase knowledge empty and section-less", () => {
    const specWithoutKnowledge = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/a.test.ts", "alpha done."),
      ),
    );
    for (const document of phaseDocumentsFromSpec(specWithoutKnowledge)) {
      expect(document.knowledge).toEqual([]);
      expect(serializePhaseDocument(document)).not.toContain("## Knowledge");
    }
  });
});

describe("phaseDocumentsFromSpec agent-judged criteria", () => {
  const AGENT_JUDGED_MARKER_LINE = "**Done when (AGENT-JUDGED):**";

  test("the marker line parses as a SEPARATE agent-judged criterion beside the executable one", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        [
          executableBlock("bun test src/a.test.ts", "alpha suite is green."),
          `${AGENT_JUDGED_MARKER_LINE} the reviewer checklist passes.`,
        ].join("\n"),
      ),
    );
    const [document] = phaseDocumentsFromSpec(specText);
    expect(document?.doneWhen).toEqual([
      { kind: "executable", description: "alpha suite is green.", command: "bun test src/a.test.ts" },
      { kind: "agent-judged", description: "the reviewer checklist passes." },
    ]);
  });

  test("the marker directly after executable prose is not glued into that prose", () => {
    const specText = gameplanSpec(
      [
        `### Phase 1: alpha ${EM_DASH} one`,
        "",
        "- [ ] a",
        "",
        EXECUTABLE_MARKER,
        "```",
        "bun test src/a.test.ts",
        "```",
        "alpha suite is green.",
        `${AGENT_JUDGED_MARKER_LINE} security checklist holds.`,
        "",
      ].join("\n"),
    );
    const [document] = phaseDocumentsFromSpec(specText);
    expect(document?.doneWhen).toEqual([
      { kind: "executable", description: "alpha suite is green.", command: "bun test src/a.test.ts" },
      { kind: "agent-judged", description: "security checklist holds." },
    ]);
  });

  test("a mixed phase round-trips through serialize/parse", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        [
          executableBlock("bun test src/a.test.ts", "alpha suite is green."),
          `${AGENT_JUDGED_MARKER_LINE} the reviewer checklist passes.`,
        ].join("\n"),
      ),
    );
    for (const document of phaseDocumentsFromSpec(specText)) {
      expect(parsePhaseDocument(serializePhaseDocument(document))).toEqual(document);
    }
  });

  test("a spec without agent-judged markers behaves exactly as before", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/a.test.ts", "alpha suite is green."),
      ),
    );
    const [document] = phaseDocumentsFromSpec(specText);
    expect(document?.doneWhen).toEqual([
      { kind: "executable", description: "alpha suite is green.", command: "bun test src/a.test.ts" },
    ]);
  });

  test("a marker line with no prose fails closed", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        [
          executableBlock("bun test src/a.test.ts", "alpha suite is green."),
          AGENT_JUDGED_MARKER_LINE,
        ].join("\n"),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("a phase carrying ONLY agent-judged criteria still fails policy A", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        `${AGENT_JUDGED_MARKER_LINE} the reviewer checklist passes.`,
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow("no executable done-when criterion");
  });
});

describe("phaseDocumentsFromSpec shell-construction guard", () => {
  function specWithCommand(command: string): string {
    return gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock(command, "alpha suite is green."),
      ),
    );
  }

  const shellCommands: ReadonlyArray<{ command: string; construction: string }> = [
    { command: "bun test $(git diff --name-only)", construction: "command substitution $()" },
    { command: 'bun test -t "quoted title" src/a.test.ts', construction: "double quotes" },
    { command: "bun test -t 'quoted title' src/a.test.ts", construction: "single quotes" },
    { command: "bun run typecheck && bun test src/a.test.ts", construction: "the && chain" },
    { command: "bun run typecheck || bun test src/a.test.ts", construction: "the || chain" },
    { command: "bun test src/a.test.ts | tee out.log", construction: "the | pipe" },
    { command: "bun test src/a.test.ts; echo done", construction: "the ; separator" },
  ];

  test("rejects every named shell construction, naming it and the package-json cure", () => {
    for (const { command, construction } of shellCommands) {
      const generate = () => phaseDocumentsFromSpec(specWithCommand(command));
      expect(generate).toThrow(PhaseGenerationError);
      expect(generate).toThrow(construction);
      expect(generate).toThrow('call it as "bun run <name>"');
    }
  });

  test("a malformed command drops the whole migration: no document of any phase survives", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/a.test.ts", "alpha suite is green."),
      ),
      phaseBlock(
        `### Phase 2: beta ${EM_DASH} two`,
        ["b"],
        executableBlock("bun run typecheck && bun test src/b.test.ts", "beta suite is green."),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("the guard names the phase whose command is malformed", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/a.test.ts", "alpha suite is green."),
      ),
      phaseBlock(
        `### Phase 2: beta ${EM_DASH} two`,
        ["b"],
        executableBlock("bun test $(ls src)", "beta suite is green."),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow('phase "beta"');
  });

  test("wraps the tokenizer's own rejections for commands free of shell constructions", () => {
    const generate = () => phaseDocumentsFromSpec(specWithCommand("-t alpha"));
    expect(generate).toThrow(PhaseGenerationError);
    expect(generate).toThrow("not spawnable");
  });

  test("clean argv commands, including multi-file arguments, pass through verbatim", () => {
    const command = "bun test src/workflow/migration.test.ts src/workflow/mcp-tools.test.ts";
    const [document] = phaseDocumentsFromSpec(specWithCommand(command));
    expect(document?.doneWhen).toEqual([
      { kind: "executable", description: "alpha suite is green.", command },
    ]);
  });
});

describe("phaseDocumentsFromSpec rejections", () => {
  test("throws when there is no # Gameplan section", () => {
    expect(() => phaseDocumentsFromSpec("# Overview\n\nno gameplan here")).toThrow(
      PhaseGenerationError,
    );
  });

  test("throws when the # Gameplan section contains prose but no phase headings", () => {
    expect(() => phaseDocumentsFromSpec("# Gameplan\n\nprose but no phases")).toThrow(
      PhaseGenerationError,
    );
  });

  test("throws when a phase heading has no task bullets", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        [],
        executableBlock("bun test src/a.test.ts", "alpha suite is green."),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws when a phase label cannot be slugified", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: !!! ${EM_DASH} title`,
        ["a"],
        executableBlock("bun test src/a.test.ts", "alpha suite is green."),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("propagates a duplicate-id graph error from non-adjacent duplicate labels", () => {
    const specText = gameplanSpec(
      phaseBlock(
        `### Phase 1: alpha ${EM_DASH} one`,
        ["a"],
        executableBlock("bun test src/one.test.ts", "one suite is green."),
      ),
      phaseBlock(
        `### Phase 2: beta ${EM_DASH} two`,
        ["b"],
        executableBlock("bun test src/two.test.ts", "two suite is green."),
      ),
      phaseBlock(
        `### Phase 3: alpha ${EM_DASH} three`,
        ["c"],
        executableBlock("bun test src/three.test.ts", "three suite is green."),
      ),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGraphValidationError);
  });
});
