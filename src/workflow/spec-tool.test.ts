import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveCorpus } from "../corpus";
import type { Corpus } from "../corpus";
import { EventWriter } from "../events";
import { phaseDocumentsFromSpec } from "./from-spec";
import { readMigratedSpec } from "./migrated-spec";
import { WORKFLOW_PHASE_DIR, applyMigration, planMigration } from "./migration";
import { serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import type { RunDefinition } from "./reducer";
import { RUN_ID_INVALID_TEXT } from "./run-lookup";
import { runStartedPayload } from "./run-payloads";
import type { RunProvenance } from "./run-payloads";
import { BOTH_SELECTORS_TEXT, NO_SPEC_MIGRATED_TEXT } from "./spec-rendering";
import { workflowSpecTool } from "./spec-tool";
import type { WorkflowSpecArgs } from "./spec-tool";

// workflow_spec reads two sources: the run's own start event (a run's spec as it started) and the
// corpus as migrate wrote it (a migrated spec as it is now). Migrations here run the real spec
// parser and the real applyMigration into a real corpus; run starts are written with the real
// producer serializer, so every answer is read from bytes the engine itself would write.

setDefaultTimeout(30_000);

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const SECOND_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const EM_DASH = String.fromCharCode(0x2014);
const NOTICE = "Nothing was written: no event, no file, no stale mark.";
const RETRIEVAL = { recallBudget: 2000, recallAnchors: {}, recallDomains: {} };
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function corpusNamed(corpusName?: string): Promise<Corpus> {
  return resolveCorpus(tempDir("mneme-spec-tool-proj-"), { corpusHome: tempDir("mneme-spec-tool-home-"), corpusName });
}

// Two phases listed zeta first, so from-spec chains alpha after zeta: dependency order and id order
// disagree, and the answer must follow the dependencies.
function orderedSpec(knowledgeLead: string): string {
  return [
    "# Knowledge",
    "",
    `- **Rule.** ${knowledgeLead}`,
    "  across two lines.",
    "",
    "# Gameplan",
    "",
    `### Phase 1: zeta ${EM_DASH} the first phase`,
    "",
    "- [ ] do the first thing",
    "",
    "**Done when (EXECUTABLE):**",
    "```",
    "bun test src/zeta.test.ts",
    "```",
    "zeta suite is green.",
    "",
    "**Done when (AGENT-JUDGED):** review approves the zeta output",
    "",
    `### Phase 2: alpha ${EM_DASH} the second phase (order-only после фазы 1)`,
    "",
    "- [ ] do the second thing",
    "",
    "**Done when (EXECUTABLE):**",
    "```",
    "bun test src/alpha.test.ts",
    "```",
    "alpha suite is green.",
    "",
  ].join("\n");
}

const ORDERED_PHASE_LINES = [
  "phase zeta · deps none",
  "- executable: bun test src/zeta.test.ts — zeta suite is green.",
  "- agent-judged: review approves the zeta output",
  "phase alpha · deps zeta",
  "- executable: bun test src/alpha.test.ts — alpha suite is green.",
];

async function migrate(corpus: Corpus, slug: string, specText: string): Promise<void> {
  const specPath = join(tempDir("mneme-spec-tool-src-"), `${slug}.md`);
  writeFileSync(specPath, specText);
  await applyMigration(planMigration(phaseDocumentsFromSpec(specText), corpus.corpusDir, slug), { specPath, corpus });
}

function phaseDocument(id: string, deps: string[] = []): PhaseDocument {
  return {
    id,
    deps,
    agentRole: "coder",
    description: `phase ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "green", command: "bun test", timeoutSeconds: null }],
    knowledge: [],
  };
}

function writePhaseFiles(corpus: Corpus, slug: string, documents: PhaseDocument[]): void {
  const specDir = join(corpus.corpusDir, WORKFLOW_PHASE_DIR, slug);
  mkdirSync(specDir, { recursive: true });
  for (const document of documents) {
    writeFileSync(join(specDir, `phase-${document.id}.md`), serializePhaseDocument(document));
  }
}

function definitionOf(documents: PhaseDocument[]): RunDefinition {
  return {
    graph: buildPhaseGraph(documents),
    steps: [{ id: "implement", maxAttempts: 2, onFail: { action: "escalate" } }],
    maxIterations: 20,
  };
}

function writer(corpus: Corpus): EventWriter {
  return new EventWriter(corpus.eventsDir, {
    sessionId: "s-spec-tool",
    mnemeVersion: "0.1.0",
    clock: () => new Date("2026-11-17T10:00:00.000Z"),
  });
}

// What a start by slug writes: the documents and the archive's Knowledge as readMigratedSpec gives
// them at that moment, the run's provenance naming the slug.
function startFromMigratedSpec(corpus: Corpus, runId: string, slug: string): void {
  const spec = readMigratedSpec(corpus.corpusDir, slug);
  const provenance: RunProvenance = {
    spec: { kind: "spec", slug, knowledge: spec.knowledge },
    baseCommit: { kind: "commit", sha: BASE_SHA },
  };
  writer(corpus).append({
    ...runStartedPayload(runId, "feature", definitionOf(spec.documents), RETRIEVAL, provenance),
    type: "workflow_run_started",
  });
}

function answer(corpus: Corpus, args: WorkflowSpecArgs): string {
  const result = workflowSpecTool({ corpus }, args);
  expect(result.isError).toBeFalsy();
  return (result.content as Array<{ text: string }>)[0]!.text;
}

// Every file of the corpus with its bytes, so "writes nothing" is checked over the whole tree.
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(directory, path)] = readFileSync(path, "base64");
    }
  };
  walk(directory);
  return files;
}

describe("workflow_spec over migrated specs", () => {
  test("with neither selector it lists the migrated specs by slug with their phase counts", async () => {
    const corpus = await corpusNamed();
    await migrate(corpus, "ordered", orderedSpec("read the archive"));
    writePhaseFiles(corpus, "solo", [phaseDocument("only")]);

    expect(answer(corpus, {}).split("\n")).toEqual([
      `Migrated specs in this corpus: 2. ${NOTICE}`,
      "- ordered · 2 phases",
      "- solo · 1 phase",
    ]);
    expect(answer(await corpusNamed(), {})).toBe(NO_SPEC_MIGRATED_TEXT);
  });

  test("a slug answers its archive's Knowledge and every phase after its deps with the done-when as written", async () => {
    const corpus = await corpusNamed();
    await migrate(corpus, "ordered", orderedSpec("read the archive"));

    expect(answer(corpus, { spec_slug: "ordered" }).split("\n")).toEqual([
      `Migrated spec "ordered" as it is in this corpus now. ${NOTICE}`,
      "knowledge:",
      "- **Rule.** read the archive across two lines.",
      ...ORDERED_PHASE_LINES,
    ]);
  });

  test("a migrated spec without its archive says the archive is absent", async () => {
    const corpus = await corpusNamed();
    writePhaseFiles(corpus, "bare", [phaseDocument("only")]);

    expect(answer(corpus, { spec_slug: "bare" }).split("\n").slice(0, 3)).toEqual([
      `Migrated spec "bare" as it is in this corpus now. ${NOTICE}`,
      "knowledge: none — specs/bare.md is absent",
      "phase only · deps none",
    ]);
  });

  test("a slug outside the grammar, an unknown slug and a folder whose phases close a cycle are answered as text", async () => {
    const corpus = await corpusNamed();
    writePhaseFiles(corpus, "loop", [phaseDocument("a", ["b"]), phaseDocument("b", ["a"])]);

    expect(answer(corpus, { spec_slug: "Spec_A" })).toBe(
      'spec slug "Spec_A" is not a slug: lowercase letters and digits separated by single dashes. Nothing was written.',
    );
    expect(answer(corpus, { spec_slug: "gamma" })).toBe(
      'no migrated spec "gamma" in this corpus; migrated specs: loop. Nothing was written.',
    );
    expect(answer(corpus, { spec_slug: "loop" })).toStartWith(
      'the phases of migrated spec "loop" do not form a graph: dependency cycle through phase ',
    );
  });
});

describe("workflow_spec over a run", () => {
  test("a run started from a migrated spec answers its slug, base commit, Knowledge and done-when while it is still running", async () => {
    const corpus = await corpusNamed();
    await migrate(corpus, "ordered", orderedSpec("read the archive"));
    startFromMigratedSpec(corpus, RUN_ID, "ordered");

    expect(answer(corpus, { run_id: RUN_ID }).split("\n")).toEqual([
      `Spec of run ${RUN_ID} on branch "feature". ${NOTICE}`,
      `spec ordered · base commit ${BASE_SHA}`,
      "knowledge:",
      "- **Rule.** read the archive across two lines.",
      ...ORDERED_PHASE_LINES,
    ]);
  });

  test("a spec migrated again after the start leaves the run's answer as it started, while the slug shows the new text", async () => {
    const corpus = await corpusNamed();
    await migrate(corpus, "ordered", orderedSpec("read the archive"));
    startFromMigratedSpec(corpus, RUN_ID, "ordered");
    rmSync(join(corpus.corpusDir, WORKFLOW_PHASE_DIR, "ordered"), { recursive: true });
    await migrate(corpus, "ordered", orderedSpec("a rewritten rule"));

    expect(answer(corpus, { run_id: RUN_ID }).split("\n")[3]).toBe("- **Rule.** read the archive across two lines.");
    expect(answer(corpus, { spec_slug: "ordered" }).split("\n")[2]).toBe("- **Rule.** a rewritten rule across two lines.");
  });

  test("a run started from texts says so, and a spec whose archive was absent at start says that", async () => {
    const corpus = await corpusNamed();
    writePhaseFiles(corpus, "bare", [phaseDocument("only")]);
    const inline: RunProvenance = { spec: { kind: "inline" }, baseCommit: { kind: "no-commits" } };
    writer(corpus).append({
      ...runStartedPayload(RUN_ID, "main", definitionOf([phaseDocument("only")]), RETRIEVAL, inline),
      type: "workflow_run_started",
    });
    startFromMigratedSpec(corpus, SECOND_RUN_ID, "bare");

    expect(answer(corpus, { run_id: RUN_ID }).split("\n").slice(1, 3)).toEqual([
      "spec none · base commit none",
      "knowledge: none — phases were passed as text",
    ]);
    expect(answer(corpus, { run_id: SECOND_RUN_ID }).split("\n").slice(1, 3)).toEqual([
      `spec bare · base commit ${BASE_SHA}`,
      "knowledge: none — specs/bare.md was absent at start",
    ]);
  });

  test("a run started before schema v25 reads as not recorded and still lists the done-when its gates checked", async () => {
    const corpus = await corpusNamed();
    const executable = { kind: "executable" as const, description: "unit tests pass", command: "bun test", timeoutSeconds: null };
    const judged = { kind: "agent-judged" as const, description: "review approves" };
    const document = { ...phaseDocument("legacy"), doneWhen: [executable, judged] };
    const payload = runStartedPayload(RUN_ID, "main", definitionOf([document]), RETRIEVAL, {
      spec: { kind: "inline" },
      baseCommit: { kind: "no-commits" },
    });
    delete payload["spec"];
    delete payload["base_commit"];
    writer(corpus).append({ ...payload, type: "workflow_run_started" });

    expect(answer(corpus, { run_id: RUN_ID }).split("\n")).toEqual([
      `Spec of run ${RUN_ID} on branch "main". ${NOTICE}`,
      "spec not recorded · base commit not recorded",
      "knowledge: not recorded — the run started before schema v25",
      "phase legacy · deps none",
      "- executable: bun test — unit tests pass",
      "- agent-judged: review approves",
    ]);
  });

  test("an id outside the grammar, an unknown or unreadable run and both selectors are text, and nothing is written", async () => {
    const corpus = await corpusNamed();
    await migrate(corpus, "ordered", orderedSpec("read the archive"));
    startFromMigratedSpec(corpus, RUN_ID, "ordered");
    startFromMigratedSpec(corpus, RUN_ID, "ordered");
    const before = snapshot(corpus.corpusDir);

    const answers = [
      answer(corpus, { run_id: "not-an-id" }),
      answer(corpus, { run_id: SECOND_RUN_ID }),
      answer(corpus, { run_id: RUN_ID }),
      answer(corpus, { run_id: RUN_ID, spec_slug: "ordered" }),
      answer(corpus, { spec_slug: "ordered" }),
      answer(corpus, {}),
    ];

    expect(answers.slice(0, 4)).toEqual([
      RUN_ID_INVALID_TEXT,
      `No workflow run ${SECOND_RUN_ID} in this corpus. Nothing was written.`,
      `Run ${RUN_ID} cannot be read from the log: duplicate workflow_run_started for one run_id. Nothing was written.`,
      BOTH_SELECTORS_TEXT,
    ]);
    expect(snapshot(corpus.corpusDir)).toEqual(before);
  });
});

describe("workflow_spec reads the corpus it is given, whatever its name", () => {
  test("a corpus named through corpus.name answers all three forms", async () => {
    const corpus = await corpusNamed("named-corpus");
    await migrate(corpus, "ordered", orderedSpec("read the archive"));
    startFromMigratedSpec(corpus, RUN_ID, "ordered");

    expect(corpus.corpusDir.endsWith("named-corpus")).toBe(true);
    expect(answer(corpus, {}).split("\n")[1]).toBe("- ordered · 2 phases");
    expect(answer(corpus, { spec_slug: "ordered" }).split("\n")[2]).toBe("- **Rule.** read the archive across two lines.");
    expect(answer(corpus, { run_id: RUN_ID }).split("\n")[1]).toBe(`spec ordered · base commit ${BASE_SHA}`);
  });
});
