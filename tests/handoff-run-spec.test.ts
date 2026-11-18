import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus } from "../src/corpus";
import type { Corpus } from "../src/corpus";
import { EventWriter } from "../src/events";
import { phaseDocumentsFromSpec } from "../src/workflow/from-spec";
import { START_BOTH_SOURCES_TEXT, START_NO_SOURCE_TEXT } from "../src/workflow/mcp-tools";
import { readMigratedSpec } from "../src/workflow/migrated-spec";
import { applyMigration, planMigration } from "../src/workflow/migration";
import { buildPhaseGraph } from "../src/workflow/phase-graph";
import { RUN_ID_INVALID_TEXT, renderRunLookupMiss } from "../src/workflow/run-lookup";
import { runStartedPayload } from "../src/workflow/run-payloads";
import type { RunProvenance } from "../src/workflow/run-payloads";
import {
  BOTH_SELECTORS_TEXT,
  KNOWLEDGE_INLINE_LINE,
  KNOWLEDGE_NOT_RECORDED_LINE,
  NO_SPEC_MIGRATED_TEXT,
  renderMigratedSpec,
  renderSpecLine,
} from "../src/workflow/spec-rendering";
import { workflowSpecTool } from "../src/workflow/spec-tool";
import type { WorkflowSpecArgs } from "../src/workflow/spec-tool";

// The handoff document tells the plugin's dev, map, resume and diary skills what the engine now
// says about a run's spec, so it quotes the engine's own texts. This guard pins COVERAGE the
// handoff-judge way — every exported long text of the contract appears VERBATIM — checks every
// example block of the shape section, in order, against the REAL tool over a real corpus, and
// renders each placeholder template the document writes through the real renderer, so a skill that
// copies a line parses exactly what the engine prints. Prose is deliberately not asserted.

setDefaultTimeout(30_000);

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-RUN-SPEC.md");
const GITIGNORE_PATH = join(REPO_ROOT, ".gitignore");
const SHAPE_MARKER = "<!-- HANDOFF-RUN-SPEC-SHAPE -->";
const SKILLS_MARKER = "<!-- HANDOFF-RUN-SPEC-SKILLS -->";
const SECTION_HEADING_PREFIX = "## ";
const CODE_FENCE = "```";
const EM_DASH = String.fromCharCode(0x2014);
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const PLACEHOLDER_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const UNKNOWN_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const RETRIEVAL = { recallBudget: 2000, recallAnchors: {}, recallDomains: {} };
const temporaryDirectories: string[] = [];

const SAMPLE_SPEC = [
  "# Knowledge",
  "",
  "- **Rule.** read the archive",
  "  across two lines.",
  "- **Limit.** the base commit separates commits only.",
  "",
  "# Gameplan",
  "",
  `### Phase 1: parse input ${EM_DASH} read the raw text`,
  "",
  "- [ ] read the input",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/parse.test.ts",
  "```",
  "the parse suite is green.",
  "",
  "**Done when (AGENT-JUDGED):** review approves the parser",
  "",
  `### Phase 2: store records ${EM_DASH} persist them (order-only после фазы 1)`,
  "",
  "- [ ] write the records",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/store.test.ts",
  "```",
  "the store suite is green.",
  "",
].join("\n");

const OTHER_SPEC = [
  "# Gameplan",
  "",
  `### Phase 1: only phase ${EM_DASH} the single step`,
  "",
  "- [ ] do it",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/only.test.ts",
  "```",
  "the only suite is green.",
  "",
].join("\n");

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

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

function contractStrings(): string[] {
  return [
    START_BOTH_SOURCES_TEXT,
    START_NO_SOURCE_TEXT,
    KNOWLEDGE_INLINE_LINE,
    KNOWLEDGE_NOT_RECORDED_LINE,
    NO_SPEC_MIGRATED_TEXT,
    BOTH_SELECTORS_TEXT,
    RUN_ID_INVALID_TEXT,
  ];
}

function sectionLines(document: string, marker: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) {
    throw new Error(`the handoff document has no ${marker} section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(SECTION_HEADING_PREFIX));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// Every code block of a section, in order, each as its lines between the fences.
function exampleBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let open = -1;
  lines.forEach((line, index) => {
    if (!line.startsWith(CODE_FENCE)) return;
    if (open === -1) {
      open = index;
    } else {
      blocks.push(lines.slice(open + 1, index));
      open = -1;
    }
  });
  return blocks;
}

async function migrate(corpus: Corpus, slug: string, specText: string): Promise<void> {
  const specPath = join(tempDir("mneme-handoff-run-spec-src-"), `${slug}.md`);
  writeFileSync(specPath, specText);
  await applyMigration(planMigration(phaseDocumentsFromSpec(specText), corpus.corpusDir, slug), { specPath, corpus });
}

function appendStart(corpus: Corpus, runId: string, provenance: RunProvenance): void {
  const documents = readMigratedSpec(corpus.corpusDir, "sample-spec").documents;
  const definition = {
    graph: buildPhaseGraph(documents),
    steps: [{ id: "implement", maxAttempts: 2, onFail: { action: "escalate" as const } }],
    maxIterations: 20,
  };
  new EventWriter(corpus.eventsDir, { sessionId: "s-handoff-run-spec", mnemeVersion: "0.1.0", clock: () => new Date() }).append({
    ...runStartedPayload(runId, "main", definition, RETRIEVAL, provenance),
    type: "workflow_run_started",
  });
}

function toolText(corpus: Corpus, args: WorkflowSpecArgs): string {
  return (workflowSpecTool({ corpus }, args).content as Array<{ text: string }>)[0]!.text;
}

const SPEC_PROVENANCE: RunProvenance = {
  spec: { kind: "spec", slug: "sample-spec", knowledge: null },
  baseCommit: { kind: "commit", sha: BASE_SHA },
};

describe("HANDOFF-RUN-SPEC contract coverage", () => {
  test("every exported long text of the contract appears verbatim in the handoff document", () => {
    const document = handoffDocument();

    expect(contractStrings().every((value) => value.length > 0)).toBe(true);
    expect(contractStrings().filter((value) => !document.includes(value))).toEqual([]);
  });

  test("the tool and its argument are named as backticked names, and both sections carry their markers", () => {
    const document = handoffDocument();

    for (const name of ["workflow_spec", "spec_slug", "workflow_start", "diary_facts"]) {
      expect(document).toContain(`\`${name}\``);
    }
    expect(document).toContain(SHAPE_MARKER);
    expect(document).toContain(SKILLS_MARKER);
  });

  test("the document is excluded from the docs/* ignore, so a fresh clone carries it", () => {
    expect(readFileSync(GITIGNORE_PATH, "utf8").split("\n")).toContain("!docs/HANDOFF-RUN-SPEC.md");
  });
});

describe("HANDOFF-RUN-SPEC examples print exactly what the engine prints", () => {
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await resolveCorpus(tempDir("mneme-handoff-run-spec-proj-"), { corpusHome: tempDir("mneme-handoff-run-spec-home-") });
    await migrate(corpus, "sample-spec", SAMPLE_SPEC);
    await migrate(corpus, "other-spec", OTHER_SPEC);
    const knowledge = readMigratedSpec(corpus.corpusDir, "sample-spec").knowledge;
    appendStart(corpus, RUN_ID, { ...SPEC_PROVENANCE, spec: { kind: "spec", slug: "sample-spec", knowledge } });
    appendStart(corpus, PLACEHOLDER_RUN_ID, { ...SPEC_PROVENANCE, spec: { kind: "spec", slug: "<slug>", knowledge: null } });
  });

  test("the shape section's five blocks are the spec lines, the run form, the slug form, the list and the non-answers", () => {
    const blocks = exampleBlocks(sectionLines(handoffDocument(), SHAPE_MARKER));

    expect(blocks.length).toBe(5);
    expect(blocks[0]).toEqual([
      renderSpecLine(SPEC_PROVENANCE),
      renderSpecLine({ spec: { kind: "inline" }, baseCommit: { kind: "no-commits" } }),
      renderSpecLine(null),
    ]);
    expect(blocks[1]).toEqual(toolText(corpus, { run_id: RUN_ID }).split("\n"));
    expect(blocks[2]).toEqual(toolText(corpus, { spec_slug: "sample-spec" }).split("\n"));
    expect(blocks[3]).toEqual(toolText(corpus, {}).split("\n"));
    expect(blocks[4]).toEqual([
      toolText(corpus, { run_id: "not-an-id" }),
      toolText(corpus, { run_id: UNKNOWN_RUN_ID }),
      toolText(corpus, { run_id: RUN_ID, spec_slug: "sample-spec" }),
      toolText(corpus, { spec_slug: "Sample_Spec" }),
      toolText(corpus, { spec_slug: "nowhere" }),
    ]);
  });

  test("each placeholder template the document quotes is what the real renderer prints for the placeholder", () => {
    const document = handoffDocument();
    const graph = buildPhaseGraph(readMigratedSpec(corpus.corpusDir, "other-spec").documents);
    const templates = [
      toolText(corpus, { run_id: PLACEHOLDER_RUN_ID }).split("\n")[2]!,
      renderMigratedSpec("<slug>", null, graph).split("\n")[1]!,
      renderRunLookupMiss({ kind: "unreadable", runId: "<run_id>", problem: "<problem>" }),
    ];

    expect(templates).toEqual([
      "knowledge: none — specs/<slug>.md was absent at start",
      "knowledge: none — specs/<slug>.md is absent",
      "Run <run_id> cannot be read from the log: <problem>. Nothing was written.",
    ]);
    expect(templates.filter((template) => !document.includes(`\`${template}\``))).toEqual([]);
  });
});
