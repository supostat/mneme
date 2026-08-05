import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorSweep } from "../src/anchor-repair";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { dumpIndex, rebuild } from "../src/index-db";
import { formatStagingList, formatSweepReport } from "../src/mcp-rendering";
import { serializeNote } from "../src/note";
import type { NoteFrontmatter } from "../src/note";
import { DEAD_ANCHOR_SINK } from "../src/staleness";
import { remember, stagingList } from "../src/staging";
import type { StagingDeps } from "../src/staging";
import { listReanchorRequests } from "../src/curation";

// The branch-aware path on REAL modules end-to-end: three anchors with three different truths — one
// parked on an unmerged branch, one a concept git never saw, one honestly deleted — must travel
// three different paths through ranking, the sweep report and the intake warnings, and the merge
// must silently resolve the parked one. The ONLY mock is the embeddings client.

setDefaultTimeout(30_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function requestIds(): () => string {
  let counter = 100;
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

async function commitProject(projectRoot: string, message: string): Promise<void> {
  await runGit(projectRoot, ["add", "-A"]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message,
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
}

async function checkout(projectRoot: string, args: string[]): Promise<void> {
  const result = await runGit(projectRoot, ["checkout", "-q", ...args]);
  if (result.exitCode !== 0) throw new Error(`git checkout failed: ${result.stderr}`);
}

const PARKED_NOTE = ulid(0);
const CONCEPT_NOTE = ulid(1);
const DELETED_NOTE = ulid(2);

async function buildFixture(): Promise<StagingDeps> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-branch-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "steady neighbor\n");
  writeFileSync(join(projectRoot, "src/doomed.ts"), "will be deleted outright\n");
  await commitProject(projectRoot, "init");
  await runGit(projectRoot, ["rm", "-q", "src/doomed.ts"]);
  await commitProject(projectRoot, "delete doomed");
  await checkout(projectRoot, ["-b", "feature"]);
  writeFileSync(join(projectRoot, "src/parked.ts"), "alive only on the feature branch\n");
  await commitProject(projectRoot, "add parked on feature");
  await checkout(projectRoot, ["main"]);
  const noteCommit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();

  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-branch-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const seeds: Array<{ id: string; body: string; anchors: string[] }> = [
    { id: PARKED_NOTE, body: "knowledge parked on an unmerged branch", anchors: ["src/parked.ts"] },
    { id: CONCEPT_NOTE, body: "knowledge anchored to a concept", anchors: ["MultiSelect"] },
    { id: DELETED_NOTE, body: "knowledge whose file was deleted", anchors: ["src/doomed.ts"] },
  ];
  for (const seed of seeds) {
    const frontmatter: NoteFrontmatter = {
      id: seed.id,
      type: "decision",
      anchors: seed.anchors,
      commit: noteCommit,
      created: "2026-07-06T10:00:00.000Z",
    };
    writeFileSync(join(corpus.notesDir, `${seed.id}.md`), serializeNote({ frontmatter, body: seed.body }));
  }
  await runGit(corpus.corpusDir, ["add", "-A"]);
  await runGit(corpus.corpusDir, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed notes", "--allow-empty",
  ]);
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-branch-e2e",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  return {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: requestIds(),
    embeddings: offlineClient(),
    eventWriter,
  };
}

test("parked, concept and deleted anchors travel three honest paths, and the merge resolves the parked one", async () => {
  const deps = await buildFixture();

  // RANKING: the real rebuild scores the parked note above the dead sink; the concept and the
  // deleted note keep sinking (their anchors are truly not here).
  await rebuild({
    indexPath: deps.corpus.indexPath,
    notesDir: deps.corpus.notesDir,
    projectRoot: deps.projectRoot,
    embeddings: deps.embeddings,
    eventWriter: deps.eventWriter,
    clock: deps.clock,
  });
  const rows = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string; staleness_boost: number }>;
  const boostOf = (id: string) => rows.find((row) => row.id === id)!.staleness_boost;
  expect(boostOf(PARKED_NOTE)).toBeGreaterThan(DEAD_ANCHOR_SINK);
  expect(boostOf(CONCEPT_NOTE)).toBe(DEAD_ANCHOR_SINK);
  expect(boostOf(DELETED_NOTE)).toBe(DEAD_ANCHOR_SINK);

  // SWEEP: three report classes, zero staging for parked/unknown, retire advice only for the
  // genuine deletion.
  const report = await anchorSweep(deps);
  expect(report.parked).toEqual([
    { noteId: PARKED_NOTE, type: "decision", oldAnchor: "src/parked.ts", branches: ["feature"] },
  ]);
  expect(report.unknownToGit).toEqual([{ noteId: CONCEPT_NOTE, type: "decision", oldAnchor: "MultiSelect" }]);
  expect(report.noSuccessor).toEqual([{ noteId: DELETED_NOTE, type: "decision", oldAnchor: "src/doomed.ts" }]);
  expect(report.staged).toEqual([]);
  expect(listReanchorRequests(deps.corpus)).toEqual([]);
  const rendered = formatSweepReport(report);
  expect(rendered).toContain("Anchor sweep (checked against 2 local branches):");
  expect(rendered).toContain(`${PARKED_NOTE} [decision]: src/parked.ts — lives on: feature`);
  expect(rendered).toContain(`${CONCEPT_NOTE} [decision]: MultiSelect`);
  expect(rendered).toContain(`note_retire { id: "${DELETED_NOTE}", reason: "<...>" }`);
  expect(rendered.match(/note_retire/g)!.length).toBe(1);

  // IDEMPOTENCY: a second sweep renders byte-identically and still stages nothing.
  expect(formatSweepReport(await anchorSweep(deps))).toBe(rendered);
  expect(listReanchorRequests(deps.corpus)).toEqual([]);

  // INTAKE: a staged note anchored to the same parked path and concept gets per-state warnings.
  await remember(deps, {
    type: "decision",
    body: "fresh note anchored to a parked path and a concept",
    anchors: ["src/parked.ts", "MultiSelect"],
    source: "mcp",
  });
  const intake = formatStagingList(await stagingList(deps), [], listReanchorRequests(deps.corpus));
  expect(intake).toContain(
    "warning: anchor src/parked.ts lives on branch feature, not here; the note takes a moderate ranking penalty until the merge",
  );
  expect(intake).toContain(
    "warning: anchor MultiSelect was never known to the project's git — likely a concept, not a file path",
  );

  // MERGE BOUNDARY: merging the feature branch makes the parked anchor tracked; the sweep goes
  // silent about it while the other two classes remain.
  const merged = await runGit(deps.projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-edit", "feature",
  ]);
  if (merged.exitCode !== 0) throw new Error(merged.stderr);
  const afterMerge = await anchorSweep(deps);
  expect(afterMerge.parked).toEqual([]);
  expect(formatSweepReport(afterMerge)).not.toContain("src/parked.ts");
  expect(afterMerge.unknownToGit.length).toBe(1);
  expect(afterMerge.noSuccessor.length).toBe(1);
});
