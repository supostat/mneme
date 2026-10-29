import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { CorpusBusyError } from "../corpus-git";
import { resolveCorpus } from "../corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../embeddings";
import type { EmbeddingsClient } from "../embeddings";
import { eventSchema } from "../event-schema";
import { EventWriter, readEvents } from "../events";
import type { StoredEvent } from "../events";
import { initRepo, runGit } from "../git";
import { openReadOnlyDatabase } from "../index-db";
import { formatMapDelete, formatMapList } from "../mcp-rendering";
import { recall } from "../recall";
import type { StagingDeps } from "../staging";
import { MapSectionValidationError, parseMapSection } from "./map-section";
import { MAP_INDEX_HEADING, writeMapSection } from "./map-store";
import { MapToolError, mapDelete, mapList, mapPut, showMapSection } from "./map-tools";
import type { MapPutInput } from "./map-tools";

// Real deps end to end: a real project repository, a real corpus repository, the real index and the
// real recall — the map tools are the plugin's write surface, so what they do to git and to the
// index is the thing under test, with the bag-of-words embedder as the only stand-in.

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index++) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const dimension = (hash >>> 0) % EMBEDDING_DIMENSION;
    vector[dimension] = vector[dimension]! + 1;
  }
  return vector;
}

function bagClient(): EmbeddingsClient {
  return {
    model: EMBEDDING_MODEL,
    embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }),
  };
}

async function buildProjectRepo(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-map-tools-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

interface Workbench {
  deps: StagingDeps;
  projectHead: string;
}

async function makeWorkbench(): Promise<Workbench> {
  const { projectRoot, commit } = await buildProjectRepo();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-map-tools-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-map-tools",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  let counter = 0;
  const deps: StagingDeps = {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => `id-${counter++}`,
    embeddings: bagClient(),
    eventWriter,
  };
  return { deps, projectHead: commit };
}

const BILLING: MapPutInput = {
  kind: "domain",
  id: "billing",
  body: "Billing issues invoices.\nEvery order closes with one.",
  anchors: ["src/a.ts"],
  terms: ["invoice", "ledger"],
};

const ORDER_TO_INVOICE: MapPutInput = {
  kind: "flow",
  id: "order-to-invoice",
  body: "An order becomes an invoice.\nFirst the cart, then the ledger.",
  anchors: [],
  depends_on: ["billing", "orders"],
  terms: ["checkout"],
};

const GLOSSARY_HEADER = "| term | domain |\n| --- | --- |\n";

async function corpusHead(deps: StagingDeps): Promise<string> {
  return (await runGit(deps.corpus.corpusDir, ["rev-parse", "HEAD"])).stdout.trim();
}

// Newest first, as git prints them; an empty repository (no commit yet) lists nothing.
async function corpusSubjects(deps: StagingDeps): Promise<string[]> {
  const log = await runGit(deps.corpus.corpusDir, ["log", "--format=%s"]);
  if (log.exitCode !== 0) return [];
  return log.stdout.split("\n").filter((line) => line !== "");
}

function eventsOfType(deps: StagingDeps, type: string): StoredEvent[] {
  return readEvents(deps.corpus.eventsDir).filter((event) => event.type === type);
}

function lastEventTypes(deps: StagingDeps, count: number): string[] {
  return readEvents(deps.corpus.eventsDir).slice(-count).map((event) => event.type);
}

function readIndexFile(deps: StagingDeps): string {
  return readFileSync(deps.corpus.mapIndexPath, "utf8");
}

function domainFile(deps: StagingDeps, id: string): string {
  return join(deps.corpus.mapDomainsDir, `${id}.md`);
}

// What git still sees changed under map/ — empty once every map write is committed.
async function mapStatus(deps: StagingDeps): Promise<string> {
  return (await runGit(deps.corpus.corpusDir, ["status", "--porcelain"], ["map"])).stdout.trim();
}

// Another session mid-commit: git refuses every writer while .git/index.lock exists.
function lockCorpusIndex(deps: StagingDeps): void {
  writeFileSync(join(deps.corpus.corpusDir, ".git", "index.lock"), "");
}

function unlockCorpusIndex(deps: StagingDeps): void {
  rmSync(join(deps.corpus.corpusDir, ".git", "index.lock"));
}

// A corrupted map — two sessions putting one id as different kinds, or a merge of two corpora —
// committed by hand, because map_put itself refuses to create it.
async function commitDuplicateFlow(deps: StagingDeps, id: string): Promise<void> {
  writeMapSection(deps.corpus, {
    frontmatter: { id, kind: "flow", anchors: [], depends_on: [], terms: [], commit: "abc1234" },
    body: "A flow under a domain's id.",
  });
  await runGit(deps.corpus.corpusDir, ["add", "."]);
  await runGit(deps.corpus.corpusDir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "duplicate"]);
}

describe("mapPut", () => {
  test("stores the section, derives INDEX.md and glossary.md, commits once, logs the write and rebuilds", async () => {
    const { deps, projectHead } = await makeWorkbench();

    const result = await mapPut(deps, BILLING);

    const head = await corpusHead(deps);
    expect(result).toEqual({ kind: "domain", id: "billing", commit: head, index: { rebuilt: true } });
    const stored = parseMapSection(readFileSync(domainFile(deps, "billing"), "utf8"));
    expect(stored).toEqual({
      frontmatter: { id: "billing", kind: "domain", anchors: ["src/a.ts"], depends_on: [], terms: ["invoice", "ledger"], commit: projectHead },
      body: BILLING.body,
    });
    expect(readIndexFile(deps)).toBe(`${MAP_INDEX_HEADING}\n\n- billing — Billing issues invoices.\n`);
    expect(readFileSync(deps.corpus.glossaryPath, "utf8")).toBe(`${GLOSSARY_HEADER}| invoice | billing |\n| ledger | billing |\n`);
    expect(await corpusSubjects(deps)).toEqual(['Put map domain "billing"']);
    const [putEvent] = eventsOfType(deps, "map_section_put");
    expect(putEvent).toMatchObject({
      id: "billing",
      kind: "domain",
      body_len: [...BILLING.body].length,
      anchors_n: 1,
      depends_on_n: 0,
      terms_n: 2,
      commit: head,
    });
    expect(eventSchema.safeParse(putEvent).success).toBe(true);
    expect(lastEventTypes(deps, 2)).toEqual(["map_section_put", "rebuild"]);
  });

  test("a repeated put with the same text mints no commit and still logs the write", async () => {
    const { deps } = await makeWorkbench();
    const first = await mapPut(deps, BILLING);

    const second = await mapPut(deps, BILLING);

    expect(second.commit).toBe(first.commit);
    expect(await corpusSubjects(deps)).toEqual(['Put map domain "billing"']);
    expect(eventsOfType(deps, "map_section_put").length).toBe(2);
  });

  test("a replace rewrites the body, re-derives INDEX.md and commits again", async () => {
    const { deps } = await makeWorkbench();
    const first = await mapPut(deps, BILLING);

    const replaced = await mapPut(deps, { ...BILLING, body: "Billing issues receipts.\nNothing else changed." });

    expect(replaced.commit).not.toBe(first.commit);
    expect(parseMapSection(readFileSync(domainFile(deps, "billing"), "utf8")).body).toBe("Billing issues receipts.\nNothing else changed.");
    expect(readIndexFile(deps)).toBe(`${MAP_INDEX_HEADING}\n\n- billing — Billing issues receipts.\n`);
    expect(await corpusSubjects(deps)).toEqual(['Put map domain "billing"', 'Put map domain "billing"']);
  });

  test("a put under an id the other kind holds is refused before anything is written", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);

    const failure = await mapPut(deps, { ...ORDER_TO_INVOICE, id: "billing", depends_on: ["orders"] }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MapToolError);
    expect((failure as Error).message).toBe('section "billing" exists as domain; delete it first');
    expect(existsSync(join(deps.corpus.mapFlowsDir, "billing.md"))).toBe(false);
    expect(await corpusSubjects(deps)).toEqual(['Put map domain "billing"']);
    expect(eventsOfType(deps, "map_section_put").length).toBe(1);
  });

  test("an invalid section is refused with its reason and nothing is written", async () => {
    const { deps } = await makeWorkbench();
    const invalid: Array<{ input: MapPutInput; reason: string }> = [
      { input: { ...BILLING, id: "Billing" }, reason: "must be a map section slug" },
      { input: { ...BILLING, anchors: ["../outside.ts"] }, reason: "anchor" },
      { input: { ...BILLING, terms: ["invoice", "invoice"] }, reason: "duplicate term: invoice" },
      { input: { ...BILLING, body: "" }, reason: "body must be 1-3000 code points" },
      {
        input: { ...BILLING, terms: Array.from({ length: 25 }, (_, index) => `term${index}`) },
        reason: "a section holds at most 24 terms: got 25",
      },
      { input: { ...BILLING, terms: ["invoice", "x".repeat(200)] }, reason: "term 2 must be at most 32 code points" },
    ];

    for (const { input, reason } of invalid) {
      const failure = await mapPut(deps, input).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MapSectionValidationError);
      expect((failure as Error).message).toContain(reason);
    }

    expect(existsSync(domainFile(deps, "billing"))).toBe(false);
    expect(existsSync(domainFile(deps, "Billing"))).toBe(false);
    expect(await corpusSubjects(deps)).toEqual([]);
    expect(readEvents(deps.corpus.eventsDir)).toEqual([]);
  });

  test("a rebuild that fails after the commit reports index.rebuilt = false and logs rebuild_failed", async () => {
    const { deps } = await makeWorkbench();
    mkdirSync(deps.corpus.indexPath);

    const result = await mapPut(deps, BILLING);

    expect(result.index.rebuilt).toBe(false);
    expect(result.commit).toBe(await corpusHead(deps));
    expect(existsSync(domainFile(deps, "billing"))).toBe(true);
    expect(lastEventTypes(deps, 2)).toEqual(["map_section_put", "rebuild_failed"]);
  });

  test("the stored section reaches a real recall after the rebuild, alone and as a domain scope", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);

    const db = openReadOnlyDatabase(deps.corpus.indexPath);
    try {
      const recallDeps = { db, embeddings: deps.embeddings, eventWriter: deps.eventWriter, clock: fixedClock };
      const unscoped = await recall(recallDeps, "invoice", 2000, "tool-call", []);
      const scoped = await recall(recallDeps, "invoice", 2000, "tool-call", ["billing"]);

      expect(unscoped.sections.map((section) => [section.id, section.kind])).toEqual([["billing", "domain"]]);
      expect(scoped.sections.map((section) => section.id)).toEqual(["billing"]);
    } finally {
      db.close();
    }
  });
});

describe("mapDelete", () => {
  test("removes the file and its INDEX.md line, re-derives the glossary, commits and logs", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);

    const result = await mapDelete(deps, "billing");

    const head = await corpusHead(deps);
    expect(result).toEqual({ id: "billing", kinds: ["domain"], commit: head, index: { rebuilt: true } });
    expect(existsSync(domainFile(deps, "billing"))).toBe(false);
    expect(readIndexFile(deps)).toBe(`${MAP_INDEX_HEADING}\n`);
    expect(readFileSync(deps.corpus.glossaryPath, "utf8")).toBe(GLOSSARY_HEADER);
    expect(await corpusSubjects(deps)).toEqual(['Delete map domain "billing"', 'Put map domain "billing"']);
    const [deletedEvent] = eventsOfType(deps, "map_section_deleted");
    expect(deletedEvent).toMatchObject({ id: "billing", kind: "domain", commit: head });
    expect(eventSchema.safeParse(deletedEvent).success).toBe(true);
    expect(lastEventTypes(deps, 2)).toEqual(["map_section_deleted", "rebuild"]);
  });

  test("an unknown or malformed id is a named error that writes nothing", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);

    const unknown = await mapDelete(deps, "nowhere").catch((error: unknown) => error);
    const malformed = await mapDelete(deps, "../billing").catch((error: unknown) => error);

    expect(unknown).toBeInstanceOf(MapToolError);
    expect((unknown as Error).message).toBe('no map section "nowhere" exists');
    expect(malformed).toBeInstanceOf(MapToolError);
    expect((malformed as Error).message).toBe('invalid map section id: "../billing"');
    expect(existsSync(domainFile(deps, "billing"))).toBe(true);
    expect(await corpusSubjects(deps)).toEqual(['Put map domain "billing"']);
    expect(eventsOfType(deps, "map_section_deleted")).toEqual([]);
  });

  test("a delete after a put whose commit failed removes the uncommitted file, commits the derived files and converges", async () => {
    const { deps } = await makeWorkbench();
    lockCorpusIndex(deps);
    await expect(mapPut(deps, BILLING)).rejects.toThrow(CorpusBusyError);
    unlockCorpusIndex(deps);
    expect(existsSync(domainFile(deps, "billing"))).toBe(true);

    const result = await mapDelete(deps, "billing");

    expect(result.kinds).toEqual(["domain"]);
    expect(existsSync(domainFile(deps, "billing"))).toBe(false);
    expect(readIndexFile(deps)).toBe(`${MAP_INDEX_HEADING}\n`);
    expect(await mapStatus(deps)).toBe("");
    expect(eventsOfType(deps, "map_section_deleted").map((event) => event.kind)).toEqual(["domain"]);
  });

  test("a delete whose commit failed is finished by its retry, not refused as an unknown section", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);
    lockCorpusIndex(deps);
    await expect(mapDelete(deps, "billing")).rejects.toThrow(CorpusBusyError);
    unlockCorpusIndex(deps);
    expect(existsSync(domainFile(deps, "billing"))).toBe(false);

    const retried = await mapDelete(deps, "billing");

    expect(retried).toEqual({ id: "billing", kinds: ["domain"], commit: await corpusHead(deps), index: { rebuilt: true } });
    expect(await corpusSubjects(deps)).toEqual(['Delete map domain "billing"', 'Put map domain "billing"']);
    expect(await mapStatus(deps)).toBe("");
    expect(eventsOfType(deps, "map_section_deleted").length).toBe(1);
  });

  test("an id held by both kinds is deleted whole: both files in one commit, one event per kind", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);
    await commitDuplicateFlow(deps, "billing");

    const result = await mapDelete(deps, "billing");

    const head = await corpusHead(deps);
    expect(result).toEqual({ id: "billing", kinds: ["domain", "flow"], commit: head, index: { rebuilt: true } });
    expect(formatMapDelete(result)).toBe(
      `Deleted map sections domain "billing" and flow "billing" (one id was held by both kinds); committed ${head}.`,
    );
    expect(existsSync(domainFile(deps, "billing"))).toBe(false);
    expect(existsSync(join(deps.corpus.mapFlowsDir, "billing.md"))).toBe(false);
    expect((await corpusSubjects(deps))[0]).toBe('Delete map domain and flow "billing"');
    expect(await mapStatus(deps)).toBe("");
    expect(eventsOfType(deps, "map_section_deleted").map((event) => [event.kind, event.commit])).toEqual([
      ["domain", head],
      ["flow", head],
    ]);
  });

  test("a delete while another section file is unreadable is refused before anything is removed", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);
    writeFileSync(domainFile(deps, "orders"), "not a section\n");

    const failure = await mapDelete(deps, "billing").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MapSectionValidationError);
    expect((failure as Error).message).toContain(domainFile(deps, "orders"));
    expect(existsSync(domainFile(deps, "billing"))).toBe(true);
    expect(eventsOfType(deps, "map_section_deleted")).toEqual([]);
  });

  test("an unreadable file is removed by a delete of its own id", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);
    writeFileSync(domainFile(deps, "billing"), "not a section\n");

    const result = await mapDelete(deps, "billing");

    expect(result.kinds).toEqual(["domain"]);
    expect(existsSync(domainFile(deps, "billing"))).toBe(false);
    expect(await mapStatus(deps)).toBe("");
  });
});

describe("mapPut on a map that does not read", () => {
  test("another unreadable section file refuses the put with its path and nothing is written", async () => {
    const { deps } = await makeWorkbench();
    writeFileSync(domainFile(deps, "orders"), "not a section\n");

    const failure = await mapPut(deps, BILLING).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MapSectionValidationError);
    expect((failure as Error).message).toContain(domainFile(deps, "orders"));
    expect(existsSync(domainFile(deps, "billing"))).toBe(false);
    expect(await corpusSubjects(deps)).toEqual([]);
    expect(eventsOfType(deps, "map_section_put")).toEqual([]);
  });

  test("an id held by both kinds refuses any put with both paths named, until it is deleted", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, BILLING);
    await commitDuplicateFlow(deps, "billing");

    const failure = await mapPut(deps, { ...BILLING, id: "orders" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MapSectionValidationError);
    expect((failure as Error).message).toBe(
      `map section id "billing" is held by both ${domainFile(deps, "billing")} and ${join(deps.corpus.mapFlowsDir, "billing.md")}; ` +
        "delete it with map_delete and put it back as one kind",
    );
    expect(existsSync(domainFile(deps, "orders"))).toBe(false);
    expect(eventsOfType(deps, "map_section_put").length).toBe(1);
  });

  test("a repeated put after the project HEAD moved records the new HEAD and mints a new commit", async () => {
    const { deps, projectHead } = await makeWorkbench();
    const first = await mapPut(deps, BILLING);
    writeFileSync(join(deps.projectRoot, "src/b.ts"), "more\n");
    await runGit(deps.projectRoot, ["add", "."]);
    await runGit(deps.projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "next"]);
    const movedHead = (await runGit(deps.projectRoot, ["rev-parse", "HEAD"])).stdout.trim();

    const second = await mapPut(deps, BILLING);

    expect(movedHead).not.toBe(projectHead);
    expect(second.commit).not.toBe(first.commit);
    expect(parseMapSection(readFileSync(domainFile(deps, "billing"), "utf8")).frontmatter.commit).toBe(movedHead);
    expect(await corpusSubjects(deps)).toEqual(['Put map domain "billing"', 'Put map domain "billing"']);
  });
});

describe("mapList and showMapSection", () => {
  test("lists domains then flows with anchor liveness, dependency names and a dangling warning, in exact lines", async () => {
    const { deps } = await makeWorkbench();
    await mapPut(deps, { ...BILLING, anchors: ["src/a.ts", "src/gone.ts"] });
    await mapPut(deps, ORDER_TO_INVOICE);

    const listed = await mapList(deps);

    expect(listed).toEqual({
      entries: [
        { id: "billing", kind: "domain", firstLine: "Billing issues invoices.", anchorsN: 2, deadN: 1, dependsOn: [], termsN: 2 },
        {
          id: "order-to-invoice",
          kind: "flow",
          firstLine: "An order becomes an invoice.",
          anchorsN: 0,
          deadN: 0,
          dependsOn: ["billing", "orders"],
          termsN: 1,
        },
      ],
      dangling: [{ id: "order-to-invoice", kind: "flow", missing: ["orders"] }],
    });
    expect(formatMapList(listed).split("\n")).toEqual([
      "billing [domain] anchors: 2, dead: 1, depends_on: (none), terms: 2 — Billing issues invoices.",
      "order-to-invoice [flow] anchors: 0, dead: 0, depends_on: billing, orders, terms: 1 — An order becomes an invoice.",
      'warning: depends_on of "order-to-invoice" names unknown section "orders"',
      "Bodies are not listed; call map_list with an id to read one section in full.",
    ]);
  });

  test("an anchor that lives only on another local branch is parked there, not counted dead", async () => {
    const { deps } = await makeWorkbench();
    const gitAs = ["-c", "user.email=t@t", "-c", "user.name=t"];
    await runGit(deps.projectRoot, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(deps.projectRoot, "src/feature-only.ts"), "feature\n");
    await runGit(deps.projectRoot, ["add", "."]);
    await runGit(deps.projectRoot, [...gitAs, "commit", "-q", "-m", "feature"]);
    await runGit(deps.projectRoot, ["checkout", "-q", "-"]);
    await mapPut(deps, { ...BILLING, anchors: ["src/feature-only.ts"] });

    const listed = await mapList(deps);

    expect(listed.entries.map((entry) => [entry.id, entry.anchorsN, entry.deadN])).toEqual([["billing", 1, 0]]);
  });

  test("an empty map lists as empty", async () => {
    const { deps } = await makeWorkbench();

    const listed = await mapList(deps);

    expect(listed).toEqual({ entries: [], dangling: [] });
    expect(formatMapList(listed)).toBe("The project map is empty.");
  });

  test("show returns the stored section whole, and an unknown id is a named error", async () => {
    const { deps, projectHead } = await makeWorkbench();
    await mapPut(deps, BILLING);

    expect(showMapSection(deps.corpus, "billing")).toEqual({
      frontmatter: { id: "billing", kind: "domain", anchors: ["src/a.ts"], depends_on: [], terms: ["invoice", "ledger"], commit: projectHead },
      body: BILLING.body,
    });
    expect(() => showMapSection(deps.corpus, "nowhere")).toThrow('no map section "nowhere" exists');
    expect(() => showMapSection(deps.corpus, "Nowhere")).toThrow('invalid map section id: "Nowhere"');
  });
});
