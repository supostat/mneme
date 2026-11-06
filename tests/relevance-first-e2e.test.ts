import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayLog } from "../scripts/replay";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter, readEvents } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { dumpIndex, dumpMapIndex } from "../src/index-db";
import { mapPut } from "../src/map/map-tools";
import { DRIFT_PENALTY_CAP } from "../src/staleness";
import { remember, stagingResolve } from "../src/staging";
import type { StagingDeps } from "../src/staging";
import { compileRecallBundle, formatRecallBundle } from "../src/workflow/memory-steps";

// Relevance before drift on REAL modules end-to-end: a decision and a map domain are written through
// remember, the human accept and map_put, then their anchor file changes twelve more times, so the
// rebuild of the last accept scores both at the drift cap. The phase bundle, the recall event and
// the offline replay must all rank them FIRST — by relevance — above a fresher note and domain that
// match the question worse. The ONLY mock is the embeddings client (offline, so recall runs fts_only).

setDefaultTimeout(120_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GIT_AUTHOR = ["-c", "user.email=t@t", "-c", "user.name=t"];
const DRIFT_COMMITS = 12;
const QUESTION = "users list keycloak account count";
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
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-relevance-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  await commitFile(projectRoot, "src/users.ts", "users v0", "Add the users list");
  await commitFile(projectRoot, "src/other.ts", "other v0", "Add the other module");
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-relevance-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-relevance-e2e",
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

test("a note and a domain drifted to the cap still lead the bundle, the recall log and its replay when they match the question best", async () => {
  const deps = await makeDeps();
  const { projectRoot } = deps;

  // Two domains and two decisions, written while their anchors are fresh. The users pair matches
  // every term of the question; the other pair shares only "users list" with it.
  const usersPut = await mapPut(deps, {
    kind: "domain",
    id: "users",
    body: "Users, their Keycloak accounts and the account count.",
    anchors: ["src/users.ts"],
  });
  expect(usersPut.index).toEqual({ rebuilt: true });
  const miscPut = await mapPut(deps, {
    kind: "domain",
    id: "misc",
    body: "Miscellaneous helpers for the users list.",
    anchors: ["src/other.ts"],
  });
  expect(miscPut.index).toEqual({ rebuilt: true });
  const usersNote = await stageDecision(
    deps,
    "users list keycloak account count: a dev staff member never gets an account",
    ["src/users.ts"],
  );
  const otherNote = await stageDecision(deps, "users list pagination defaults for the admin table", ["src/other.ts"]);

  // The users anchor then changes twelve times, past the ten-commit cap; src/other.ts stays put.
  for (let index = 1; index <= DRIFT_COMMITS; index++) {
    await commitFile(projectRoot, "src/users.ts", `users v${index}`, `Change the users list ${index}`);
  }
  await accept(deps, usersNote);
  await accept(deps, otherNote);

  // INDEX: the rebuild of the last accept scored the drift — the fixture is genuinely drifted.
  const notes = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string; staleness_boost: number }>;
  const boostOf = (id: string) => notes.find((row) => row.id === id)!.staleness_boost;
  expect(boostOf(usersNote)).toBe(DRIFT_PENALTY_CAP);
  expect(boostOf(otherNote)).toBe(0);
  const map = JSON.parse(dumpMapIndex(deps.corpus.indexPath)) as { sections: Array<{ id: string; staleness_boost: number }> };
  expect(map.sections.map((row) => [row.id, row.staleness_boost]).sort()).toEqual([
    ["misc", 0],
    ["users", DRIFT_PENALTY_CAP],
  ]);

  // BUNDLE: relevance ranks the drifted pair first; under rrf + staleness_boost both fell second.
  const bundle = await compileRecallBundle(deps, {
    phaseDescription: QUESTION,
    anchorPaths: [],
    domains: [],
    budget: 100000,
  });
  expect(bundle.notes.map((note) => note.id)).toEqual([usersNote, otherNote]);
  expect(bundle.sections.map((section) => section.id)).toEqual(["users", "misc"]);
  const formatted = formatRecallBundle(bundle);
  expect(formatted.indexOf("id: users")).toBeLessThan(formatted.indexOf("id: misc"));
  expect(formatted.indexOf(`[decision] ${usersNote}`)).toBeLessThan(formatted.indexOf(`[decision] ${otherNote}`));

  // LOG: the recall event carries the ranks that prove the order was decided by relevance, and the
  // drift the comparator was asked to ignore.
  const recallEvents = readEvents(deps.corpus.eventsDir).filter((event) => event.type === "recall");
  expect(recallEvents.length).toBe(1);
  const candidates = recallEvents[0]!.candidates as Array<{
    id: string;
    fts_rank: number | null;
    staleness_boost: number;
    in_budget: boolean;
  }>;
  expect(candidates.map((candidate) => [candidate.id, candidate.fts_rank, candidate.staleness_boost, candidate.in_budget])).toEqual([
    [usersNote, 1, DRIFT_PENALTY_CAP, true],
    [otherNote, 2, 0, true],
  ]);
  const sections = recallEvents[0]!.sections as Array<{ id: string; fts_rank: number | null; returned: boolean }>;
  expect(sections.map((section) => [section.id, section.fts_rank, section.returned])).toEqual([
    ["users", 1, true],
    ["misc", 2, true],
  ]);

  // REPLAY: the offline tool recomputes the same order from the logged keys alone — one event of the
  // current schema, reproduced, nothing skipped.
  const report = replayLog(readEvents(deps.corpus.eventsDir), {});
  expect(report.replays.length).toBe(1);
  expect(report.replays[0]!.identical).toBe(true);
  expect(report.skippedPreCandidates).toBe(0);
  expect(report.skippedPreRule).toBe(0);
});
