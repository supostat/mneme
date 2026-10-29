import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import { MAP_SECTIONS_COMPONENT } from "../src/doctor";
import { EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { openReadOnlyDatabase } from "../src/index-db";
import { MAP_SECTION_LIMIT_RULE } from "../src/map/map-section";
import { MAP_INDEX_HEADING, readSectionFiles, sectionPath } from "../src/map/map-store";
import { mapDelete, mapPut } from "../src/map/map-tools";
import type { MapListResult, MapPutInput } from "../src/map/map-tools";
import {
  formatMapDelete,
  formatMapList,
  formatMapPut,
  INDEX_CATCH_UP_ADVICE,
  INDEX_NOT_REBUILT_LABEL,
  MAP_EMPTY_LINE,
  MAP_FENCE_BEGIN_LABEL,
  MAP_LIST_BODIES_HINT,
} from "../src/mcp-rendering";
import { recall, RECALL_GAP_NOTICE } from "../src/recall";
import { resolveHead } from "../src/staging";
import type { StagingDeps } from "../src/staging";
import { MEMORY_GAPS_LABEL } from "../src/stats";
import { workflowStartTool } from "../src/workflow/mcp-tools";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The handoff document tells the plugin's setup, plan, dev and arch skills how the project map is
// stored, written and recalled and how a memory gap is announced, so it quotes the engine's own
// texts. This guard pins COVERAGE the handoff-note-body way — every exported piece of the contract
// and every map tool name must appear VERBATIM — checks the document's example recall answer
// against the REAL fence label, and ROUND-TRIPS every result line and refusal the tools and recall
// sections quote: the template is taken as the document writes it, its placeholders are filled with
// sample values, and the real formatter, validator or tool — on a temporary corpus where a refusal
// needs one — must print exactly that line for the same values. Prose is deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-MAP.md");
const SERVER_SOURCE_PATH = join(REPO_ROOT, "src", "mcp-server.ts");
const RECALL_MARKER = "<!-- HANDOFF-MAP-RECALL -->";
const MARKERS = [
  "HANDOFF-MAP-STORAGE",
  "HANDOFF-MAP-TOOLS",
  "HANDOFF-MAP-RECALL",
  "HANDOFF-MAP-GAP",
  "HANDOFF-MAP-SKILLS",
];
const SECTION_HEADING_PREFIX = "## ";
const CODE_FENCE = "```";
const MAP_TOOL_PREFIX = "map_";
const MAP_FENCE_BEGIN = new RegExp(`^----- ${MAP_FENCE_BEGIN_LABEL} ([0-9a-f]{16}) -----$`);
const KIND_LINE_PREFIX = "kind: ";
const NOTES_LINE_PREFIX = "notes: ";
const ANGLE_PLACEHOLDER = /<[^<>]+>/g;
const SAMPLE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const fixedClock = () => new Date("2026-10-29T10:00:00.000Z");

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

// The map tools are read from the server source exactly as the README guard reads every tool, so a
// renamed or added map tool fails here before the document can go stale.
function mapToolNames(): string[] {
  const source = readFileSync(SERVER_SOURCE_PATH, "utf8");
  return [...source.matchAll(/registerTool\("([a-z_]+)"/g)]
    .map((match) => match[1]!)
    .filter((name) => name.startsWith(MAP_TOOL_PREFIX));
}

function contractStrings(): string[] {
  return [
    MAP_SECTION_LIMIT_RULE,
    RECALL_GAP_NOTICE,
    MAP_SECTIONS_COMPONENT,
    MAP_FENCE_BEGIN_LABEL,
    INDEX_NOT_REBUILT_LABEL,
    INDEX_CATCH_UP_ADVICE,
    MAP_INDEX_HEADING,
    MAP_EMPTY_LINE,
    MAP_LIST_BODIES_HINT,
    MEMORY_GAPS_LABEL,
  ];
}

function recallSectionLines(document: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.includes(RECALL_MARKER));
  if (start === -1) {
    throw new Error(`the handoff document has no ${RECALL_MARKER} section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(SECTION_HEADING_PREFIX));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// The first code block of the recall section, between its opening and closing fence.
function exampleBlock(sectionLines: string[]): string[] {
  const open = sectionLines.findIndex((line) => line.startsWith(CODE_FENCE));
  const close = sectionLines.findIndex((line, index) => index > open && line === CODE_FENCE);
  if (open === -1 || close === -1) {
    throw new Error("the recall section shows no example block");
  }
  return sectionLines.slice(open + 1, close);
}

interface RoundTrip {
  template: string;
  placeholderValues: Record<string, string>;
  engineText: () => Promise<string>;
}

interface Workbench {
  deps: StagingDeps;
  uncommittedProjectRoot: string;
  uncommittedHeadStderr: string;
}

const BILLING: MapPutInput = {
  kind: "domain",
  id: "billing",
  body: "Billing issues invoices.\nEvery order closes with one.",
  anchors: ["src/a.ts"],
  terms: ["invoice", "ledger"],
};

const CHECKOUT_LISTING: MapListResult = {
  entries: [
    {
      id: "checkout",
      kind: "flow",
      firstLine: "An order becomes an invoice.",
      anchorsN: 2,
      deadN: 1,
      dependsOn: ["billing", "orders"],
      termsN: 3,
    },
  ],
  dangling: [{ id: "checkout", kind: "flow", missing: ["orders"] }],
};

const PHASE_ONE = serializePhaseDocument({
  id: "phase-one",
  deps: [],
  agentRole: "coder",
  description: "Work on phase-one",
  tasks: ["do the work"],
  doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
  knowledge: [],
});

// Every refusal here is decided before anything is embedded, so the guard needs no embedder.
const UNAVAILABLE_EMBEDDER: EmbeddingsClient = {
  model: EMBEDDING_MODEL,
  embed: async () => ({ available: false, embeddings: [], retries: 0 }),
};

async function committedProjectRepo(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-handoff-map-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

// One stored domain, and a repository without commits beside it. Every refusal of the table leaves
// the corpus as it found it, so one workbench serves the whole table.
async function makeWorkbench(): Promise<Workbench> {
  const projectRoot = await committedProjectRepo();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-handoff-map-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const deps: StagingDeps = {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => crypto.randomUUID(),
    embeddings: UNAVAILABLE_EMBEDDER,
    eventWriter: new EventWriter(corpus.eventsDir, { sessionId: "s-handoff-map", mnemeVersion: "0.1.0", clock: fixedClock }),
  };
  await mapPut(deps, BILLING);
  const uncommittedProjectRoot = mkdtempSync(join(tmpdir(), "mneme-handoff-map-empty-"));
  await initRepo(uncommittedProjectRoot);
  const uncommittedHead = await runGit(uncommittedProjectRoot, ["rev-parse", "HEAD"]);
  return { deps, uncommittedProjectRoot, uncommittedHeadStderr: uncommittedHead.stderr.trim() };
}

async function refusalOf(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the engine accepted a call the handoff documents as a refusal");
}

async function recallRefusal(deps: StagingDeps, domain: string): Promise<string> {
  const db = openReadOnlyDatabase(deps.corpus.indexPath);
  try {
    const recallDeps = { db, embeddings: deps.embeddings, eventWriter: deps.eventWriter, clock: deps.clock };
    return await refusalOf(() => recall(recallDeps, "invoice", 2000, "tool-call", [domain]));
  } finally {
    db.close();
  }
}

async function startRefusal(deps: StagingDeps, recallDomains: Record<string, string[]>): Promise<string> {
  return refusalOf(() =>
    workflowStartTool(deps, {
      phases: [PHASE_ONE],
      steps: [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }],
      max_iterations: 10,
      recall_domains: recallDomains,
    }),
  );
}

// Another session mid-commit: git refuses every writer while .git/index.lock exists. The put
// rewrites the stored section byte for byte, so the refused commit leaves nothing behind.
async function busyCorpusRefusal(deps: StagingDeps): Promise<string> {
  const lockPath = join(deps.corpus.corpusDir, ".git", "index.lock");
  writeFileSync(lockPath, "");
  try {
    return await refusalOf(() => mapPut(deps, BILLING));
  } finally {
    rmSync(lockPath);
  }
}

function roundTrips(workbench: Workbench): RoundTrip[] {
  const { deps } = workbench;
  const domainPath = sectionPath(deps.corpus, "domain", "billing");
  const flowPath = sectionPath(deps.corpus, "flow", "billing");
  return [
    {
      template: 'Stored map section <kind> "<id>"; committed <sha>.',
      placeholderValues: { "<kind>": "domain", "<id>": "billing", "<sha>": SAMPLE_COMMIT },
      engineText: async () =>
        formatMapPut({ kind: "domain", id: "billing", commit: SAMPLE_COMMIT, index: { rebuilt: true } }),
    },
    {
      template: "Index not rebuilt: <reason>",
      placeholderValues: { "<reason>": "database is locked" },
      engineText: async () =>
        formatMapPut({
          kind: "domain",
          id: "billing",
          commit: SAMPLE_COMMIT,
          index: { rebuilt: false, reason: "database is locked" },
        }),
    },
    {
      template: 'Deleted map section <kind> "<id>"; committed <sha>.',
      placeholderValues: { "<kind>": "flow", "<id>": "checkout", "<sha>": SAMPLE_COMMIT },
      engineText: async () =>
        formatMapDelete({ id: "checkout", kinds: ["flow"], commit: SAMPLE_COMMIT, index: { rebuilt: true } }),
    },
    {
      template: 'Deleted map sections domain "<id>" and flow "<id>" (one id was held by both kinds); committed <sha>.',
      placeholderValues: { "<id>": "billing", "<sha>": SAMPLE_COMMIT },
      engineText: async () =>
        formatMapDelete({ id: "billing", kinds: ["domain", "flow"], commit: SAMPLE_COMMIT, index: { rebuilt: true } }),
    },
    {
      template: "<id> [<kind>] anchors: N, dead: K, depends_on: a, b, terms: M — <первая строка тела>",
      placeholderValues: {
        "<id>": "checkout",
        "<kind>": "flow",
        N: "2",
        K: "1",
        a: "billing",
        b: "orders",
        M: "3",
        "<первая строка тела>": "An order becomes an invoice.",
      },
      engineText: async () => formatMapList(CHECKOUT_LISTING),
    },
    {
      template: 'warning: depends_on of "<id>" names unknown section "<x>"',
      placeholderValues: { "<id>": "checkout", "<x>": "orders" },
      engineText: async () => formatMapList(CHECKOUT_LISTING),
    },
    {
      template:
        'id is "<id>"; it must be a map section slug: lowercase letters, digits, underscore or dash, ' +
        "starting with a letter or digit, at most 64 characters",
      placeholderValues: { "<id>": "Billing" },
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, id: "Billing" })),
    },
    {
      template: "body must be 1-3000 code points",
      placeholderValues: {},
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, body: "" })),
    },
    {
      template: "body first line must be non-empty",
      placeholderValues: {},
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, body: "\nEvery order closes with one." })),
    },
    {
      template: "duplicate term: <term>",
      placeholderValues: { "<term>": "ledger" },
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, terms: ["ledger", "ledger"] })),
    },
    {
      template: "a section holds at most 24 terms: got <n>",
      placeholderValues: { "<n>": "25" },
      engineText: () =>
        refusalOf(() => mapPut(deps, { ...BILLING, terms: Array.from({ length: 25 }, (_, index) => `term-${index}`) })),
    },
    {
      template: "term <position> must be at most 32 code points",
      placeholderValues: { "<position>": "2" },
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, terms: ["ledger", "x".repeat(33)] })),
    },
    {
      template: "term <position> contains foreign tool/protocol markup and was rejected: <token>",
      placeholderValues: { "<position>": "2", "<token>": "END MNEME MAP" },
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, terms: ["ledger", "END MNEME MAP"] })),
    },
    {
      template: "a section cannot depend on itself: <id>",
      placeholderValues: { "<id>": "billing" },
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, depends_on: ["billing"] })),
    },
    {
      template: 'section "<id>" exists as <kind>; delete it first',
      placeholderValues: { "<id>": "billing", "<kind>": "domain" },
      engineText: () => refusalOf(() => mapPut(deps, { ...BILLING, kind: "flow" })),
    },
    {
      template: 'no map section "<id>" exists',
      placeholderValues: { "<id>": "orders" },
      engineText: () => refusalOf(() => mapDelete(deps, "orders")),
    },
    {
      template: 'invalid map section id: "<id>"',
      placeholderValues: { "<id>": "../billing" },
      engineText: () => refusalOf(() => mapDelete(deps, "../billing")),
    },
    {
      template:
        "project has no resolvable HEAD - a repository without commits cannot anchor notes or map sections; " +
        "make the first commit, then retry: <stderr>",
      placeholderValues: { "<stderr>": workbench.uncommittedHeadStderr },
      engineText: () => refusalOf(() => resolveHead(workbench.uncommittedProjectRoot)),
    },
    {
      template: "another session is committing to this corpus; retry",
      placeholderValues: {},
      engineText: () => busyCorpusRefusal(deps),
    },
    // The store reads the map whole before any write, so a put, a delete of another id and a rebuild
    // all refuse with this one message; the duplicate is caught from the file list, before parsing.
    {
      template:
        'map section id "<id>" is held by both <domain path> and <flow path>; ' +
        "delete it with map_delete and put it back as one kind",
      placeholderValues: { "<id>": "billing", "<domain path>": domainPath, "<flow path>": flowPath },
      engineText: () =>
        refusalOf(() =>
          readSectionFiles([
            { path: domainPath, kind: "domain", id: "billing" },
            { path: flowPath, kind: "flow", id: "billing" },
          ]),
        ),
    },
    {
      template: 'no map domain "<id>"',
      placeholderValues: { "<id>": "orders" },
      engineText: () => recallRefusal(deps, "orders"),
    },
    // A phase's bundle is compiled by the same recall, and its refusal is re-raised word for word.
    {
      template: 'no map domain "<x>"',
      placeholderValues: { "<x>": "orders" },
      engineText: () => recallRefusal(deps, "orders"),
    },
    {
      template: 'recall_domains names unknown phase "<id>"',
      placeholderValues: { "<id>": "ghost-phase" },
      engineText: () => startRefusal(deps, { "ghost-phase": ["billing"] }),
    },
    {
      template: 'recall_domains for phase "<id>": "<x>" is not a map section slug',
      placeholderValues: { "<id>": "phase-one", "<x>": "Billing" },
      engineText: () => startRefusal(deps, { "phase-one": ["Billing"] }),
    },
    {
      template: 'recall_domains for phase "<id>": no map domain "<x>"',
      placeholderValues: { "<id>": "phase-one", "<x>": "orders" },
      engineText: () => startRefusal(deps, { "phase-one": ["orders"] }),
    },
  ];
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One pass over the template, so a substituted value is never rewritten by a later placeholder. A
// placeholder is a whole token — `<id>` or a bare `N` — never a letter inside a word. Every angle
// placeholder the document writes must get a value, and every value must find its placeholder, so
// neither the table nor the document can drift without failing here.
function fillTemplate(template: string, placeholderValues: Record<string, string>): string {
  const placeholders = Object.keys(placeholderValues);
  const unvalued = (template.match(ANGLE_PLACEHOLDER) ?? []).filter((placeholder) => !(placeholder in placeholderValues));
  if (unvalued.length > 0) {
    throw new Error(`"${template}" has placeholders without a sample value: ${unvalued.join(", ")}`);
  }
  if (placeholders.length === 0) return template;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(?:${placeholders.map(escapeForPattern).join("|")})(?![A-Za-z0-9_])`,
    "g",
  );
  const filled = new Set<string>();
  const text = template.replace(pattern, (placeholder) => {
    filled.add(placeholder);
    return placeholderValues[placeholder]!;
  });
  const unused = placeholders.filter((placeholder) => !filled.has(placeholder));
  if (unused.length > 0) {
    throw new Error(`"${template}" does not hold the placeholders ${unused.join(", ")}`);
  }
  return text;
}

function holdsWholeLines(text: string, lines: string): boolean {
  return `\n${text}\n`.includes(`\n${lines}\n`);
}

describe("HANDOFF-MAP contract coverage", () => {
  test("the guard reads a non-empty contract and exactly three map tools (the guard's own guard)", () => {
    const strings = contractStrings();

    expect(strings.every((value) => value.length > 0)).toBe(true);
    expect(new Set(strings).size).toBe(strings.length);
    expect(mapToolNames().sort()).toEqual(["map_delete", "map_list", "map_put"]);
  });

  test("every piece of the engine's contract appears verbatim in the handoff document", () => {
    const document = handoffDocument();

    const missing = contractStrings().filter((value) => !document.includes(value));

    expect(missing).toEqual([]);
  });

  test("every map tool is named in the handoff document as a backticked name", () => {
    const document = handoffDocument();

    const missing = mapToolNames().filter((name) => !document.includes(`\`${name}\``));

    expect(missing).toEqual([]);
  });

  test("each documented section carries its anchor marker, so a rewrite cannot drop one silently", () => {
    const document = handoffDocument();

    for (const marker of MARKERS) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });

  test("the example recall answer opens with a map block whose kind and notes precede the body, then a note block under the same nonce", () => {
    const block = exampleBlock(recallSectionLines(handoffDocument()));
    const nonce = MAP_FENCE_BEGIN.exec(block[0] ?? "")?.[1];
    if (nonce === undefined) {
      throw new Error("the example block does not open with a map fence");
    }

    const kind = block.findIndex((line) => line.startsWith(KIND_LINE_PREFIX));
    const notes = block.findIndex((line) => line.startsWith(NOTES_LINE_PREFIX));
    const mapEnd = block.indexOf(`----- END MNEME MAP ${nonce} -----`);

    expect(kind).toBeGreaterThan(0);
    expect(notes).toBeGreaterThan(kind);
    // At least one body line sits between notes: and the closing map fence.
    expect(mapEnd).toBeGreaterThan(notes + 1);
    expect(block[mapEnd + 1]).toBe(`----- BEGIN MNEME NOTE ${nonce} -----`);
    expect(block[block.length - 1]).toBe(`----- END MNEME NOTE ${nonce} -----`);
  });
});

describe("HANDOFF-MAP result lines and refusals round-trip through the engine", () => {
  let workbench: Workbench;

  beforeAll(async () => {
    workbench = await makeWorkbench();
  });

  test("every round-tripped template is quoted verbatim between backticks, each once in the table", () => {
    const document = handoffDocument();
    const templates = roundTrips(workbench).map((roundTrip) => roundTrip.template);

    const unquoted = templates.filter((template) => !document.includes(`\`${template}\``));

    expect(unquoted).toEqual([]);
    expect(new Set(templates).size).toBe(templates.length);
  });

  test("each template filled with sample values is a whole line the real formatter, validator or tool prints for them", async () => {
    const mismatches: Array<{ expected: string; engineText: string }> = [];

    for (const roundTrip of roundTrips(workbench)) {
      const expected = fillTemplate(roundTrip.template, roundTrip.placeholderValues);
      const engineText = await roundTrip.engineText();
      if (!holdsWholeLines(engineText, expected)) mismatches.push({ expected, engineText });
    }

    expect(mismatches).toEqual([]);
  });
});
