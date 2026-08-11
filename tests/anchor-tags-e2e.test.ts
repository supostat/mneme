import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorSweep } from "../src/anchor-repair";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import { listRetagRequests } from "../src/curation";
import { runDoctor } from "../src/doctor";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { dumpIndex, rebuild } from "../src/index-db";
import { formatStagingList } from "../src/mcp-rendering";
import { parseNote, serializeNote } from "../src/note";
import type { NoteFrontmatter } from "../src/note";
import { recall } from "../src/recall";
import { DEAD_ANCHOR_SINK } from "../src/staleness";
import { countStagedNotes, remember, stagingList, stagingResolve } from "../src/staging";
import type { StagingDeps } from "../src/staging";

// The tags lifecycle on REAL modules end-to-end — the b52c6722 scenario from the corpus
// measurement: a note whose nine anchors are all CONCEPTS (class names, domain terms, DB columns)
// used to sink to DEAD_ANCHOR_SINK forever; the retag path moves them into tags through the human
// gate, after which the note ranks neutral and becomes FINDABLE by a tag term. The ONLY mock is
// the embeddings client.

setDefaultTimeout(60_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(): () => string {
  let counter = 0;
  return () => ulid(counter++);
}

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

// The nine concept anchors of the measurement's showcase note b52c6722 — class names, domain
// terms, a DB column, a branch name, a project name, a UI component. Not one is a file path.
const NINE_CONCEPTS = [
  "Tickets::FindSimilarGroup",
  "TicketGroups::ChangeStatus",
  "soft-delete",
  "board-terminal-column-this-week",
  "invariant",
  "lock ordering",
  "ticket_groups.terminal_at",
  "3320-tickets-system",
  "MultiSelect",
];

async function buildFixture(): Promise<StagingDeps> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-tags-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "steady neighbor\n");
  await runGit(projectRoot, ["add", "-A"]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);

  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-tags-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-tags-e2e",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  return {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: sequentialIds(),
    embeddings: offlineClient(),
    eventWriter,
  };
}

function boostOf(deps: StagingDeps, id: string): number {
  const rows = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string; staleness_boost: number }>;
  return rows.find((row) => row.id === id)!.staleness_boost;
}

async function recallIds(deps: StagingDeps, query: string): Promise<string[]> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(deps.corpus.indexPath, { readonly: true });
  try {
    const result = await recall(
      { db, embeddings: deps.embeddings, eventWriter: deps.eventWriter, clock: deps.clock },
      query,
      10000,
      "tool-call",
    );
    return result.returnedIds;
  } finally {
    db.close();
  }
}

test("nine concept anchors travel the retag path: sink -> staged retags -> tags-only note that ranks neutral and recalls by tag", async () => {
  const deps = await buildFixture();
  const legacyNote = ulid(0);

  // LEGACY INTAKE: agents honestly wrote concepts into anchors because no file existed. The note
  // stages and the human accepts it — exactly how the 44 measured anchors entered the corpus.
  await remember(deps, {
    type: "decision",
    body: "disabled means zero memberships and zero live tga; no default_scope active",
    anchors: NINE_CONCEPTS,
    source: "mcp",
  });
  const accepted = await stagingResolve(deps, legacyNote, "accept");
  expect(accepted.outcome).toBe("accepted");

  // THE MEASURED DAMAGE: every anchor is unknown to git, worst-anchor-wins sinks the whole note.
  expect(boostOf(deps, legacyNote)).toBe(DEAD_ANCHOR_SINK);

  // SWEEP: all nine concepts stage retag requests through the human gate — nothing is auto-moved.
  const report = await anchorSweep(deps);
  expect(report.unknownToGit.length).toBe(9);
  expect(report.noSuccessor).toEqual([]);
  expect(listRetagRequests(deps.corpus).length).toBe(9);
  const noteOnDiskBefore = readFileSync(join(deps.corpus.notesDir, `${legacyNote}.md`), "utf8");
  expect(parseNote(noteOnDiskBefore).frontmatter.anchors).toEqual(NINE_CONCEPTS);

  // HUMAN GATE: accept each retag one by one; the frontmatter converges to zero anchors, nine tags.
  for (const request of listRetagRequests(deps.corpus)) {
    const result = await stagingResolve(deps, request.requestId, "accept");
    expect(result.outcome).toBe("retagged");
  }
  const retagged = parseNote(readFileSync(join(deps.corpus.notesDir, `${legacyNote}.md`), "utf8"));
  expect(retagged.frontmatter.anchors).toEqual([]);
  expect(retagged.frontmatter.tags).toEqual(NINE_CONCEPTS);
  expect(listRetagRequests(deps.corpus)).toEqual([]);

  // RANKING HEALED: the tags-only note rides the neutral 0 boost, not the sink.
  expect(boostOf(deps, legacyNote)).toBe(0);

  // FINDABLE BY TAG: an FTS query with a tag term surfaces the note (offline embedder — the FTS
  // channel alone carries it); the tag term appears nowhere in the body.
  expect(await recallIds(deps, "MultiSelect")).toContain(legacyNote);

  // QUEUE CLEAN: nothing is left for the curator.
  expect(countStagedNotes(deps.corpus)).toBe(0);
  expect(formatStagingList(await stagingList(deps), [], [], [])).toBe(
    "The staging queue is empty. Nothing to review.",
  );

  // IDEMPOTENCY: a sweep over the healed corpus is silent — nothing missing, nothing staged.
  const after = await anchorSweep(deps);
  expect(after.unknownToGit).toEqual([]);
  expect(after.noSuccessor).toEqual([]);
  expect(after.untracked).toEqual([]);
  expect(after.parked).toEqual([]);
  expect(after.staged).toEqual([]);
  expect(listRetagRequests(deps.corpus)).toEqual([]);
});

test("the new path: remember with tags from the start warns, accepts, ranks neutral and recalls by tag", async () => {
  const deps = await buildFixture();
  const conceptNote = ulid(0);

  await remember(deps, {
    type: "decision",
    body: "lock ordering against SetAssignees prevents the deadlock",
    anchors: [],
    tags: ["Tickets::FindSimilarGroup", "deadlock"],
    source: "mcp",
  });

  // INTAKE: the pathless notice informs (not a warning) and the tags render.
  const intake = formatStagingList(await stagingList(deps), [], [], []);
  expect(intake).toContain("anchors: (none)");
  expect(intake).toContain("tags: Tickets::FindSimilarGroup, deadlock");
  expect(intake).toContain("note: no path anchors — this note takes no part in anchorOverlap or staleness ranking");

  const accepted = await stagingResolve(deps, conceptNote, "accept");
  expect(accepted.outcome).toBe("accepted");

  // Same neutrality and findability as the retagged legacy note.
  expect(boostOf(deps, conceptNote)).toBe(0);
  expect(await recallIds(deps, "deadlock")).toContain(conceptNote);

  // The sweep has nothing to say about a tags-only note.
  const report = await anchorSweep(deps);
  expect(report.unknownToGit).toEqual([]);
  expect(report.untracked).toEqual([]);
});

test("doctor names a legacy markup artifact in exactly one note_bodies finding", async () => {
  const deps = await buildFixture();
  const legacyId = ulid(9);
  const frontmatter: NoteFrontmatter = {
    id: legacyId,
    type: "decision",
    anchors: ["src/a.ts"],
    commit: "abc1234",
    created: "2026-07-06T10:00:00.000Z",
  };
  writeFileSync(
    join(deps.corpus.notesDir, `${legacyId}.md`),
    serializeNote({ frontmatter, body: "legacy converter left </body> in this body" }),
  );
  await rebuild({
    indexPath: deps.corpus.indexPath,
    notesDir: deps.corpus.notesDir,
    projectRoot: deps.projectRoot,
    embeddings: deps.embeddings,
    eventWriter: deps.eventWriter,
    clock: deps.clock,
  });

  const doctorReport = await runDoctor({ corpusDir: deps.corpus.corpusDir, embedder: deps.embeddings });

  const bodies = doctorReport.components.find((component) => component.name === "note_bodies")!;
  expect(bodies.status).toBe("degraded");
  expect(bodies.detail).toContain("1 note(s) carry foreign protocol markup");
  expect(bodies.detail).toContain(legacyId);
  expect(bodies.detail).toContain("</body");
});
