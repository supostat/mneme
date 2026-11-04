import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { dumpIndex, dumpMapIndex } from "../src/index-db";
import { mapPut } from "../src/map/map-tools";
import { DRIFT_PENALTY_PER_COMMIT, UNRESOLVED_BASE_PENALTY } from "../src/staleness";
import { remember, stagingResolve } from "../src/staging";
import type { StagingDeps } from "../src/staging";
import { compileRecallBundle, formatRecallBundle } from "../src/workflow/memory-steps";

// The rebase path on REAL modules end-to-end: notes and a map section are written through remember,
// the human accept and map_put while their commits are alive; then git rewrites or drops those
// commits — a rebase, a squash merge, a deleted branch — and a gc removes the objects. The index
// and the phase bundle must tell the rebased copy from a base that is truly lost. The ONLY mock is
// the embeddings client.

setDefaultTimeout(60_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GIT_AUTHOR = ["-c", "user.email=t@t", "-c", "user.name=t"];
const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function sequentialIds(): () => string {
  let counter = 0;
  return () => {
    const n = counter++;
    return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
  };
}

function offlineClient(): EmbeddingsClient {
  return {
    model: EMBEDDING_MODEL,
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await runGit(repoDir, [...GIT_AUTHOR, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commitFile(projectRoot: string, path: string, content: string, subject: string): Promise<string> {
  writeFileSync(join(projectRoot, path), `${content}\n`);
  await git(projectRoot, ["add", "--", path]);
  await git(projectRoot, ["commit", "-q", "-m", subject]);
  return git(projectRoot, ["rev-parse", "HEAD"]);
}

async function makeDeps(): Promise<StagingDeps> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-rebase-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  await commitFile(projectRoot, "src/base.ts", "start", "Start the project");
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-rebase-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-rebase-e2e",
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

async function stageDecision(deps: StagingDeps, body: string, anchors: string[]): Promise<string> {
  const staged = await remember(deps, { type: "decision", body, anchors, source: "mcp" });
  if (staged.outcome !== "staged") throw new Error(`remember did not stage: ${staged.outcome}`);
  return staged.noteId;
}

async function accept(deps: StagingDeps, noteId: string): Promise<void> {
  const resolved = await stagingResolve(deps, noteId, "accept");
  expect(resolved).toMatchObject({ outcome: "accepted", index: { rebuilt: true } });
}

async function trackedIdentityFiles(deps: StagingDeps): Promise<string[]> {
  const listed = await git(deps.corpus.corpusDir, ["ls-files", "--", "commit-identities"]);
  return listed.split("\n").filter((line) => line !== "").sort();
}

async function collectGarbage(projectRoot: string, commits: string[]): Promise<void> {
  await git(projectRoot, ["reflog", "expire", "--expire-unreachable=now", "--all"]);
  await git(projectRoot, ["gc", "-q", "--prune=now"]);
  for (const commit of commits) {
    expect((await runGit(projectRoot, ["cat-file", "-e", commit])).exitCode).not.toBe(0);
  }
}

test("a rebased note and section drift from their copies after gc, while a squashed and a recordless base are demoted with no label", async () => {
  const deps = await makeDeps();
  const { projectRoot } = deps;

  // SQUASH: a decision accepted on a topic branch records its commit; main takes the work as one
  // squash commit with its own subject and the branch is deleted, so the record has no copy on HEAD.
  await git(projectRoot, ["checkout", "-q", "-b", "topic"]);
  const squashed = await commitFile(projectRoot, "src/refund.ts", "round down", "Tune the refund rule");
  const refundNote = await stageDecision(deps, "refund decision: refunds round down", ["src/refund.ts"]);
  await accept(deps, refundNote);
  expect(await trackedIdentityFiles(deps)).toEqual([`commit-identities/${squashed}`]);
  await git(projectRoot, ["checkout", "-q", "main"]);
  await git(projectRoot, ["merge", "-q", "--squash", "topic"]);
  await git(projectRoot, ["commit", "-q", "-m", "Merge the refund rule"]);
  await git(projectRoot, ["branch", "-q", "-D", "topic"]);

  // NO RECORD: a decision staged on a spike branch waits in the queue while the branch is deleted;
  // its accept comes after the gc, when the object is gone and nothing can be recorded for it.
  await git(projectRoot, ["checkout", "-q", "-b", "spike"]);
  const spiked = await commitFile(projectRoot, "src/base.ts", "start faster", "Try a faster start");
  const spikeNote = await stageDecision(deps, "start decision: a faster start was tried", ["src/base.ts"]);
  await git(projectRoot, ["checkout", "-q", "main"]);
  await git(projectRoot, ["branch", "-q", "-D", "spike"]);

  // REBASE: the ledger decision and the ledger section are written on two feature commits; main
  // moves forward, feature is rebased onto it and the ledger changes once more on the copies.
  await git(projectRoot, ["checkout", "-q", "-b", "feature"]);
  const noteCommit = await commitFile(projectRoot, "src/ledger.ts", "ledger v1", "Split the ledger");
  const ledgerNote = await stageDecision(deps, "ledger decision: split the ledger into accounts", ["src/ledger.ts"]);
  await accept(deps, ledgerNote);
  const sectionCommit = await commitFile(projectRoot, "src/ledger.ts", "ledger v2", "Document the ledger");
  const put = await mapPut(deps, { kind: "domain", id: "ledger", body: "The ledger domain.", anchors: ["src/ledger.ts"] });
  expect(put.index).toEqual({ rebuilt: true });
  expect(await trackedIdentityFiles(deps)).toEqual(
    [squashed, noteCommit, sectionCommit].map((commit) => `commit-identities/${commit}`).sort(),
  );
  await git(projectRoot, ["checkout", "-q", "main"]);
  await commitFile(projectRoot, "src/main.ts", "main", "Move main forward");
  await git(projectRoot, ["checkout", "-q", "feature"]);
  await git(projectRoot, ["rebase", "-q", "main"]);
  await commitFile(projectRoot, "src/ledger.ts", "ledger v3", "Extend the ledger");

  await collectGarbage(projectRoot, [squashed, spiked, noteCommit, sectionCommit]);
  await accept(deps, spikeNote);
  expect(readdirSync(deps.corpus.commitIdentitiesDir).sort()).toEqual([squashed, noteCommit, sectionCommit].sort());

  // RANKING, from the rebuild of that last accept: the note counts two ledger commits since its
  // copy, the section one since its own — counting from the gone originals would sink both.
  const notes = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string; staleness_boost: number }>;
  const boostOf = (id: string) => notes.find((row) => row.id === id)!.staleness_boost;
  expect(boostOf(ledgerNote)).toBe(2 * DRIFT_PENALTY_PER_COMMIT);
  expect(boostOf(refundNote)).toBe(UNRESOLVED_BASE_PENALTY);
  expect(boostOf(spikeNote)).toBe(UNRESOLVED_BASE_PENALTY);
  const map = JSON.parse(dumpMapIndex(deps.corpus.indexPath)) as { sections: Array<{ id: string; staleness_boost: number }> };
  expect(map.sections.map((row) => [row.id, row.staleness_boost])).toEqual([["ledger", DRIFT_PENALTY_PER_COMMIT]]);

  // BUNDLE: the rebased decision is this branch's — reachable, unlabeled, first; the squashed and
  // the recordless ones are demoted behind it, and no base that is lost is credited to a branch.
  const bundle = await compileRecallBundle(deps, {
    phaseDescription: "decision",
    anchorPaths: [],
    domains: [],
    budget: 100000,
  });
  const layerOf = (note: (typeof bundle.notes)[number]) => [note.id, note.branchReachable, note.branchName];
  expect(layerOf(bundle.notes[0]!)).toEqual([ledgerNote, true, null]);
  expect(bundle.notes.slice(1).map(layerOf).sort()).toEqual(
    [
      [refundNote, false, null],
      [spikeNote, false, null],
    ].sort(),
  );
  const formatted = formatRecallBundle(bundle);
  expect(formatted).toContain(`[decision] ${ledgerNote}\n`);
  expect(formatted).not.toContain("(from branch");
});
