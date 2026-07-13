import { describe, expect, test } from "bun:test";
import { phaseDocumentsFromSpec } from "./from-spec";
import { PhaseGenerationError } from "./phase-generation";
import { PhaseGraphValidationError, buildPhaseGraph } from "./phase-graph";
import { parsePhaseDocument, serializePhaseDocument } from "./phase-document";
import type { ExecutableCriterion } from "./phase-document";

const EM_DASH = String.fromCharCode(0x2014);

function gameplanSpec(...phaseBlocks: string[]): string {
  return ["# Gameplan", "", ...phaseBlocks].join("\n");
}

function phaseBlock(heading: string, tasks: string[], doneWhen: string): string {
  return [heading, "", ...tasks.map((task) => `- [ ] ${task}`), "", `**Done when:** ${doneWhen}`, ""].join(
    "\n",
  );
}

describe("phaseDocumentsFromSpec happy path", () => {
  const specText = gameplanSpec(
    phaseBlock(`### Phase 1: alpha core ${EM_DASH} first title`, ["do first", "do second"], "alpha is green."),
    phaseBlock(`### Phase 2: beta engine ${EM_DASH} second title`, ["build beta"], "beta is green."),
    phaseBlock(`### Phase 3: gamma surface ${EM_DASH} third title`, ["ship gamma"], "gamma is green."),
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

  test("emits only executable done-when criteria", () => {
    const documents = phaseDocumentsFromSpec(specText);
    for (const document of documents) {
      expect(document.doneWhen.every((criterion) => criterion.kind === "executable")).toBe(true);
    }
  });

  test("carries the phase title and acceptance prose into the description", () => {
    const [firstDocument] = phaseDocumentsFromSpec(specText);
    expect(firstDocument?.description).toContain("first title");
    expect(firstDocument?.description).toContain("alpha is green.");
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
  `### Phase 2: normalize records ${EM_DASH} canonical form`,
  "",
  "- [ ] map the fields",
  "",
  "**Done when:** records reach canonical form.",
  "",
  `### Phase 3: index store ${EM_DASH} build the searchable index`,
  "",
  "- [ ] write the index",
  "",
  "**Done when:** the index round-trips.",
  "",
  `### Phase 4: query surface ${EM_DASH} expose retrieval`,
  "",
  "- [ ] wire the endpoint",
  "",
  "**Done when:** a query returns results.",
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

describe("phaseDocumentsFromSpec injected done-when", () => {
  test("applies a caller-supplied executable command to every phase", () => {
    const doneWhen: ExecutableCriterion[] = [
      { kind: "executable", description: "types check", command: "bunx tsc --noEmit" },
    ];
    const specText = gameplanSpec(
      phaseBlock(`### Phase 1: alpha ${EM_DASH} one`, ["a"], "a green."),
      phaseBlock(`### Phase 2: beta ${EM_DASH} two`, ["b"], "b green."),
    );
    const documents = phaseDocumentsFromSpec(specText, doneWhen);
    for (const document of documents) {
      expect(document.doneWhen).toEqual(doneWhen);
    }
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
      [`### Phase 1: alpha ${EM_DASH} one`, "", "**Done when:** green.", ""].join("\n"),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws when a phase label cannot be slugified", () => {
    const specText = gameplanSpec(phaseBlock(`### Phase 1: !!! ${EM_DASH} title`, ["a"], "green."));
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGenerationError);
  });

  test("throws when the injected done-when list is empty", () => {
    const specText = gameplanSpec(phaseBlock(`### Phase 1: alpha ${EM_DASH} one`, ["a"], "green."));
    expect(() => phaseDocumentsFromSpec(specText, [])).toThrow(PhaseGenerationError);
  });

  test("propagates a duplicate-id graph error from non-adjacent duplicate labels", () => {
    const specText = gameplanSpec(
      phaseBlock(`### Phase 1: alpha ${EM_DASH} one`, ["a"], "green."),
      phaseBlock(`### Phase 2: beta ${EM_DASH} two`, ["b"], "green."),
      phaseBlock(`### Phase 3: alpha ${EM_DASH} three`, ["c"], "green."),
    );
    expect(() => phaseDocumentsFromSpec(specText)).toThrow(PhaseGraphValidationError);
  });
});
