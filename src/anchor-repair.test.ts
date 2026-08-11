import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config";
import { resolveCorpus } from "./corpus";
import type { Corpus } from "./corpus";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { initRepo, runGit } from "./git";
import { serializeNote } from "./note";
import type { NoteFrontmatter, NoteType } from "./note";
import type { StagingDeps } from "./staging";
import { readFileSync } from "node:fs";
import { parseNote } from "./note";
import { stagingResolve } from "./staging";
import { listReanchorRequests, listRetagRequests, readReanchorRequest } from "./curation";
import { RENAME_SCORE_FLOOR, anchorSweep } from "./anchor-repair";
import { formatSweepReport } from "./mcp-rendering";

// Every case spawns a real git repository and runs a real rename trace over it.
setDefaultTimeout(30_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

// Request ids mint from 100 upward so they never collide with fixture note ids (0-9).
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

// Ten distinct lines so a partial rewrite lands the git rename similarity between the detection
// threshold and the pinned floor.
function fileContent(name: string): string {
  return Array.from({ length: 10 }, (_, index) => `line ${index} of ${name} carrying distinctive payload`).join("\n") + "\n";
}

async function commitProject(projectRoot: string, message: string): Promise<void> {
  await runGit(projectRoot, ["add", "-A"]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message,
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
}

async function buildProjectRepo(fileNames: string[]): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-sweep-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (const name of fileNames) writeFileSync(join(projectRoot, name), fileContent(name));
  await commitProject(projectRoot, "init");
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

async function renameInProject(projectRoot: string, from: string, to: string): Promise<void> {
  await runGit(projectRoot, ["mv", from, to]);
  await commitProject(projectRoot, `rename ${from}`);
}

async function checkout(projectRoot: string, args: string[]): Promise<void> {
  const result = await runGit(projectRoot, ["checkout", "-q", ...args]);
  if (result.exitCode !== 0) throw new Error(`git checkout failed: ${result.stderr}`);
}

// Adds a branch carrying one extra committed file, then returns the worktree to main.
async function parkFileOnBranch(projectRoot: string, branch: string, path: string): Promise<void> {
  await checkout(projectRoot, ["-b", branch]);
  writeFileSync(join(projectRoot, path), fileContent(path));
  await commitProject(projectRoot, `add ${path} on ${branch}`);
  await checkout(projectRoot, ["main"]);
}

interface AcceptedNoteSpec {
  id: string;
  body: string;
  anchors: string[];
  type?: NoteType;
}

async function makeDeps(specs: AcceptedNoteSpec[], liveFiles: string[]): Promise<StagingDeps> {
  const { projectRoot, commit } = await buildProjectRepo(liveFiles);
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-sweep-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  for (const spec of specs) {
    const frontmatter: NoteFrontmatter = {
      id: spec.id,
      type: spec.type ?? "decision",
      anchors: spec.anchors,
      commit,
      created: "2026-07-06T10:00:00.000Z",
    };
    writeFileSync(join(corpus.notesDir, `${spec.id}.md`), serializeNote({ frontmatter, body: spec.body }));
  }
  await runGit(corpus.corpusDir, ["add", "-A"]);
  await runGit(corpus.corpusDir, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed notes", "--allow-empty",
  ]);
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-sweep",
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

function eventsOfType(corpus: Corpus, type: string): StoredEvent[] {
  return readEvents(corpus.eventsDir).filter((event) => event.type === type);
}

describe("anchorSweep staging", () => {
  test("a single confident candidate is staged through the real noteReanchor and read back by the real readReanchorRequest", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "note whose anchor moved", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");

    const report = await anchorSweep(deps);

    expect(report.staged.length).toBe(1);
    const staged = report.staged[0]!;
    expect(staged.noteId).toBe(ulid(0));
    expect(staged.oldAnchor).toBe("src/old.ts");
    expect(staged.newAnchor).toBe("src/new.ts");
    expect(staged.score).toBeGreaterThanOrEqual(RENAME_SCORE_FLOOR);
    // The dep edge is real: what the sweep staged is exactly what the request reader returns.
    expect(readReanchorRequest(deps.corpus, staged.requestId)).toEqual({
      requestId: staged.requestId,
      targetId: ulid(0),
      oldAnchor: "src/old.ts",
      newAnchor: "src/new.ts",
      score: staged.score,
      source: "sweep",
    });
    expect(report.ambiguous).toEqual([]);
    expect(report.noSuccessor).toEqual([]);
    expect(report.missingByType.decision).toBe(1);
    const swept = eventsOfType(deps.corpus, "anchor_sweep");
    expect(swept.length).toBe(1);
    expect(swept[0]!.staged_n).toBe(1);
    expect(eventsOfType(deps.corpus, "note_reanchor_staged").length).toBe(1);
    const rendered = formatSweepReport(report);
    expect(rendered).toContain(`${ulid(0)} [decision]: src/old.ts -> src/new.ts`);
  });

  test("two rename candidates for one path stage nothing and land in the ambiguous branch", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "forked history", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/b.ts");
    writeFileSync(join(deps.projectRoot, "src/old.ts"), fileContent("src/old.ts"));
    await commitProject(deps.projectRoot, "recreate old");
    await renameInProject(deps.projectRoot, "src/old.ts", "src/c.ts");

    const report = await anchorSweep(deps);

    expect(report.staged).toEqual([]);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
    expect(report.ambiguous.length).toBe(1);
    const candidatePaths = report.ambiguous[0]!.candidates.map((candidate) => candidate.path).sort();
    expect(candidatePaths).toEqual(["src/b.ts", "src/c.ts"]);
    const rendered = formatSweepReport(report);
    expect(rendered).toContain("ambiguous (pick the path yourself with anchor_repair):");
  });

  test("a file deleted outright reports no successor with a ready note_retire line", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "anchored to a deleted file", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await runGit(deps.projectRoot, ["rm", "-q", "src/old.ts"]);
    await commitProject(deps.projectRoot, "delete old");

    const report = await anchorSweep(deps);

    expect(report.staged).toEqual([]);
    expect(report.ambiguous).toEqual([]);
    expect(report.noSuccessor).toEqual([{ noteId: ulid(0), type: "decision", oldAnchor: "src/old.ts" }]);
    const rendered = formatSweepReport(report);
    expect(rendered).toContain(`consider note_retire { id: "${ulid(0)}", reason: "<...>" }`);
  });

  test("a rename chain is collapsed to its endpoint", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "chained rename", anchors: ["src/a1.ts"] }],
      ["src/a1.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/a1.ts", "src/a2.ts");
    await renameInProject(deps.projectRoot, "src/a2.ts", "src/a3.ts");

    const report = await anchorSweep(deps);

    expect(report.staged.length).toBe(1);
    expect(report.staged[0]!.oldAnchor).toBe("src/a1.ts");
    expect(report.staged[0]!.newAnchor).toBe("src/a3.ts");
  });

  test("a rename cycle stages the live path instead of reading as deletion", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "anchored to the cycle's middle name", anchors: ["src/b.ts"] }],
      ["src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/a.ts", "src/b.ts");
    await renameInProject(deps.projectRoot, "src/b.ts", "src/a.ts");

    const report = await anchorSweep(deps);

    expect(report.noSuccessor).toEqual([]);
    expect(report.ambiguous).toEqual([]);
    expect(report.staged.length).toBe(1);
    expect(report.staged[0]!.oldAnchor).toBe("src/b.ts");
    expect(report.staged[0]!.newAnchor).toBe("src/a.ts");
  });

  test("anchor-neutral notes are skipped but counted in the type breakdown", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "generalized pattern", anchors: ["src/old.ts"], type: "pattern" },
        { id: ulid(1), body: "place-bound decision", anchors: ["src/old.ts"] },
      ],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");

    const report = await anchorSweep(deps);

    expect(report.skippedNeutralN).toBe(1);
    expect(report.missingByType.pattern).toBe(1);
    expect(report.missingByType.decision).toBe(1);
    expect(report.staged.map((entry) => entry.noteId)).toEqual([ulid(1)]);
  });

  test("a clean corpus yields an empty report, an empty staging queue, and a quiet render", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "healthy note", anchors: ["src/a.ts"] }],
      ["src/a.ts"],
    );

    const report = await anchorSweep(deps);

    expect(report.staged).toEqual([]);
    expect(report.ambiguous).toEqual([]);
    expect(report.noSuccessor).toEqual([]);
    expect(report.skippedNeutralN).toBe(0);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
    expect(formatSweepReport(report)).toBe("Anchor sweep: no missing anchors to repair. Nothing was staged.");
    const swept = eventsOfType(deps.corpus, "anchor_sweep");
    expect(swept[0]!.staged_n).toBe(0);
    expect(swept[0]!.no_successor_n).toBe(0);
  });

  test("a rename rewritten by half stays below the pinned floor: ambiguous with the score shown, no stage", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "half-rewritten successor", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await runGit(deps.projectRoot, ["mv", "src/old.ts", "src/new.ts"]);
    const kept = fileContent("src/old.ts").split("\n").slice(0, 6);
    const rewritten = Array.from({ length: 4 }, (_, index) => `wholly different line ${index} after the rewrite`);
    writeFileSync(join(deps.projectRoot, "src/new.ts"), [...kept, ...rewritten].join("\n") + "\n");
    await commitProject(deps.projectRoot, "rename and rewrite");

    const report = await anchorSweep(deps);

    expect(report.staged).toEqual([]);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
    expect(report.ambiguous.length).toBe(1);
    const candidate = report.ambiguous[0]!.candidates[0]!;
    expect(candidate.path).toBe("src/new.ts");
    expect(candidate.score).toBeLessThan(RENAME_SCORE_FLOOR);
    expect(formatSweepReport(report)).toContain(`src/new.ts (${candidate.score}%)`);
  });

  test("an anchor parked on another branch is report-only: no stage, no retire line, branch named", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "knowledge parked on a feature branch", anchors: ["src/parked.ts"] }],
      ["src/a.ts"],
    );
    await parkFileOnBranch(deps.projectRoot, "feature", "src/parked.ts");

    const report = await anchorSweep(deps);

    expect(report.parked).toEqual([
      { noteId: ulid(0), type: "decision", oldAnchor: "src/parked.ts", branches: ["feature"] },
    ]);
    expect(report.staged).toEqual([]);
    expect(report.noSuccessor).toEqual([]);
    expect(report.unknownToGit).toEqual([]);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
    expect(report.branchesChecked).toBe(2);
    const rendered = formatSweepReport(report);
    expect(rendered).toContain("Anchor sweep (checked against 2 local branches):");
    expect(rendered).toContain(`${ulid(0)} [decision]: src/parked.ts — lives on: feature`);
    expect(rendered).not.toContain("note_retire");
    const swept = eventsOfType(deps.corpus, "anchor_sweep");
    expect(swept[0]!.parked_n).toBe(1);
  });

  test("a concept anchor git never saw stages a retag request without a retire line", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "anchored to a concept, not a path", anchors: ["MultiSelect"] }],
      ["src/a.ts"],
    );

    const report = await anchorSweep(deps);

    expect(report.unknownToGit.length).toBe(1);
    const entry = report.unknownToGit[0]!;
    expect(entry.noteId).toBe(ulid(0));
    expect(entry.oldAnchor).toBe("MultiSelect");
    const requests = listRetagRequests(deps.corpus);
    expect(requests.length).toBe(1);
    expect(requests[0]!.requestId).toBe(entry.requestId);
    expect(requests[0]!.anchor).toBe("MultiSelect");
    expect(report.noSuccessor).toEqual([]);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
    const rendered = formatSweepReport(report);
    expect(rendered).toContain("unknown to git (a concept, not a path — a retag request is staged");
    expect(rendered).toContain(`${ulid(0)} [decision]: MultiSelect -> tags — request ${entry.requestId}`);
    expect(rendered).not.toContain("note_retire");
    const swept = eventsOfType(deps.corpus, "anchor_sweep");
    expect(swept[0]!.unknown_to_git_n).toBe(1);
    expect(swept[0]!.retag_staged_n).toBe(1);
    expect(eventsOfType(deps.corpus, "note_retag_staged").length).toBe(1);
  });

  test("accepting a staged retag moves the anchor into tags and commits the corpus", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "soft-delete invariant note", anchors: ["soft-delete"] }],
      ["src/a.ts"],
    );
    const report = await anchorSweep(deps);
    const requestId = report.unknownToGit[0]!.requestId;

    const result = await stagingResolve(deps, requestId, "accept");

    expect(result.outcome).toBe("retagged");
    if (result.outcome === "retagged") {
      expect(result.anchor).toBe("soft-delete");
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    const stored = parseNote(readFileSync(join(deps.corpus.notesDir, `${ulid(0)}.md`), "utf8"));
    expect(stored.frontmatter.anchors).toEqual([]);
    expect(stored.frontmatter.tags).toEqual(["soft-delete"]);
    expect(listRetagRequests(deps.corpus)).toEqual([]);
    expect(eventsOfType(deps.corpus, "note_retag_resolved").length).toBe(1);
  });

  test("rejecting a staged retag leaves the note untouched", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "concept note kept as is", anchors: ["MultiSelect"] }],
      ["src/a.ts"],
    );
    const report = await anchorSweep(deps);
    const requestId = report.unknownToGit[0]!.requestId;

    const result = await stagingResolve(deps, requestId, "reject");

    expect(result.outcome).toBe("retag_rejected");
    const stored = parseNote(readFileSync(join(deps.corpus.notesDir, `${ulid(0)}.md`), "utf8"));
    expect(stored.frontmatter.anchors).toEqual(["MultiSelect"]);
    expect(stored.frontmatter.tags).toBeUndefined();
    expect(listRetagRequests(deps.corpus)).toEqual([]);
  });

  test("a gitignored on-disk anchor lands in the untracked report class without staging", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "anchored to a build artifact", anchors: ["dist/out.js"] }],
      ["src/a.ts"],
    );
    writeFileSync(join(deps.projectRoot, ".gitignore"), "dist/\n");
    mkdirSync(join(deps.projectRoot, "dist"), { recursive: true });
    writeFileSync(join(deps.projectRoot, "dist/out.js"), "built artifact\n");

    const report = await anchorSweep(deps);

    expect(report.untracked).toEqual([{ noteId: ulid(0), type: "decision", oldAnchor: "dist/out.js" }]);
    expect(report.unknownToGit).toEqual([]);
    expect(listRetagRequests(deps.corpus)).toEqual([]);
    const rendered = formatSweepReport(report);
    expect(rendered).toContain("untracked on disk (gitignored or never added");
    expect(rendered).toContain(`${ulid(0)} [decision]: dist/out.js`);
    const swept = eventsOfType(deps.corpus, "anchor_sweep");
    expect(swept[0]!.untracked_n).toBe(1);
    expect(swept[0]!.retag_staged_n).toBe(0);
  });

  test("a re-run stages no second retag and keeps the parked class stable", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "parked note", anchors: ["src/parked.ts"] },
        { id: ulid(1), body: "concept note", anchors: ["soft-delete"] },
      ],
      ["src/a.ts"],
    );
    await parkFileOnBranch(deps.projectRoot, "feature", "src/parked.ts");

    const first = await anchorSweep(deps);
    const second = await anchorSweep(deps);

    expect(first.unknownToGit.length).toBe(1);
    // The pending retag request makes the second pass skip the concept anchor SILENTLY.
    expect(second.unknownToGit).toEqual([]);
    expect(listRetagRequests(deps.corpus).length).toBe(1);
    expect(second.parked).toEqual(first.parked);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
  });

  test("a partially repaired corpus mentions only the still-missing anchor and a re-run stays silent", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "already repaired note", anchors: ["src/a.ts"] },
        { id: ulid(1), body: "still broken note", anchors: ["src/old.ts"] },
      ],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");

    const report = await anchorSweep(deps);

    // The repaired note appears NOWHERE: not staged, not reported, not counted.
    expect(report.staged.map((entry) => entry.noteId)).toEqual([ulid(1)]);
    expect(report.missingByType.decision).toBe(1);
    expect(formatSweepReport(report)).not.toContain(ulid(0));

    // A second pass finds the same missing anchor already pending and skips it silently.
    const second = await anchorSweep(deps);

    expect(second.staged).toEqual([]);
    expect(second.ambiguous).toEqual([]);
    expect(second.noSuccessor).toEqual([]);
    expect(listReanchorRequests(deps.corpus).length).toBe(1);
  });
});
