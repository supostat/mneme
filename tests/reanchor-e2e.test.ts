import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorSweep } from "../src/anchor-repair";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { dumpIndex } from "../src/index-db";
import { formatStagingList, formatSweepReport } from "../src/mcp-rendering";
import { parseNote, serializeNote } from "../src/note";
import type { NoteFrontmatter } from "../src/note";
import { DEAD_ANCHOR_SINK, stalenessBoost } from "../src/staleness";
import { createLivenessContext } from "../src/anchor-liveness";
import { countStagedNotes, stagingList, stagingResolve } from "../src/staging";
import type { StagingDeps } from "../src/staging";
import { listReanchorRequests, listRetireRequests } from "../src/curation";

// The main path on REAL modules end-to-end: a project rename kills an anchor, the sweep traces it,
// the staging surface shows it, a human accept repairs it, and the repaired note leaves the
// dead-anchor sink. The ONLY mock is the embeddings client — the network boundary; git, corpus,
// staging and the index are all real.

setDefaultTimeout(30_000);

const NOTE_ID = "01ARZ3NDEKTSV4RRFFQ69G5F00";
const REQUEST_ID = "01ARZ3NDEKTSV4RRFFQ69G5F34";

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

async function buildFixture(): Promise<{ deps: StagingDeps; noteCommit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(
    join(projectRoot, "src/old.ts"),
    Array.from({ length: 10 }, (_, index) => `line ${index} of the module that will move`).join("\n") + "\n",
  );
  writeFileSync(join(projectRoot, "src/a.ts"), "steady neighbor\n");
  await commitProject(projectRoot, "init");
  const noteCommit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();

  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const frontmatter: NoteFrontmatter = {
    id: NOTE_ID,
    type: "decision",
    anchors: ["src/old.ts"],
    commit: noteCommit,
    created: "2026-07-06T10:00:00.000Z",
  };
  writeFileSync(
    join(corpus.notesDir, `${NOTE_ID}.md`),
    serializeNote({ frontmatter, body: "knowledge that outlived its file path" }),
  );
  await runGit(corpus.corpusDir, ["add", "-A"]);
  await runGit(corpus.corpusDir, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed notes", "--allow-empty",
  ]);
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-e2e",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  const deps: StagingDeps = {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => REQUEST_ID,
    embeddings: offlineClient(),
    eventWriter,
  };
  return { deps, noteCommit };
}

test("rename -> sweep -> staging surface -> accept repairs the anchor, and the repaired corpus is silent", async () => {
  const { deps, noteCommit } = await buildFixture();

  // The refactoring: the anchored file moves, the note's address dies.
  await runGit(deps.projectRoot, ["mv", "src/old.ts", "src/new.ts"]);
  await commitProject(deps.projectRoot, "rename old to new");
  expect(
    await stalenessBoost(await createLivenessContext(deps.projectRoot), ["src/old.ts"], noteCommit),
  ).toBe(DEAD_ANCHOR_SINK);

  // The sweep traces the rename and stages exactly one confident repair.
  const report = await anchorSweep(deps);
  expect(report.staged.length).toBe(1);
  const staged = report.staged[0]!;
  expect(staged.noteId).toBe(NOTE_ID);
  expect(staged.oldAnchor).toBe("src/old.ts");
  expect(staged.newAnchor).toBe("src/new.ts");
  expect(countStagedNotes(deps.corpus)).toBe(1);

  // The staging surface a curator reads: the request is visible with old -> new and its score.
  const rendered = formatStagingList(
    await stagingList(deps),
    listRetireRequests(deps.corpus),
    listReanchorRequests(deps.corpus),
  );
  expect(rendered).toContain(`re-anchor request for note ${NOTE_ID} (accept or reject only)`);
  expect(rendered).toContain(`anchor: src/old.ts -> src/new.ts (rename score ${staged.score}%)`);

  // The human decision: accept rewrites the frontmatter, commits the corpus, rebuilds the index.
  const result = await stagingResolve(deps, staged.requestId, "accept");
  expect(result.outcome).toBe("reanchored");
  const repaired = parseNote(readFileSync(join(deps.corpus.notesDir, `${NOTE_ID}.md`), "utf8"));
  expect(repaired.frontmatter.anchors).toEqual(["src/new.ts"]);
  expect(repaired.body).toBe("knowledge that outlived its file path");
  const corpusLog = await runGit(deps.corpus.corpusDir, ["log", "--format=%s"]);
  expect(corpusLog.stdout).toContain(`Re-anchor note ${NOTE_ID.slice(0, 8)}`);
  const indexed = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string }>;
  expect(indexed.map((row) => row.id)).toEqual([NOTE_ID]);

  // The sink is lifted: the repaired note scores above the dead-anchor floor.
  const boost = await stalenessBoost(
    await createLivenessContext(deps.projectRoot),
    repaired.frontmatter.anchors,
    noteCommit,
  );
  expect(boost).toBeGreaterThan(DEAD_ANCHOR_SINK);

  // Idempotency: a second sweep over the repaired corpus reports silence and stages nothing.
  const second = await anchorSweep(deps);
  expect(second.staged).toEqual([]);
  expect(second.ambiguous).toEqual([]);
  expect(second.noSuccessor).toEqual([]);
  expect(second.skippedNeutralN).toBe(0);
  expect(formatSweepReport(second)).toBe("Anchor sweep: no missing anchors to repair. Nothing was staged.");
  expect(countStagedNotes(deps.corpus)).toBe(0);
});
