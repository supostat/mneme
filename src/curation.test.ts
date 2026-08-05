import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config";
import { resolveCorpus } from "./corpus";
import type { Corpus } from "./corpus";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { initRepo, runGit } from "./git";
import { dumpIndex } from "./index-db";
import { parseNote, serializeNote } from "./note";
import type { NoteFrontmatter, NoteType } from "./note";
import { stagingResolve, countStagedNotes, StagingError } from "./staging";
import type { StagingDeps } from "./staging";
import {
  CurationError,
  listReanchorRequests,
  listRetireRequests,
  noteReanchor,
  noteRetire,
  notesList,
  showNote,
} from "./curation";
import { formatStagingList } from "./mcp-rendering";

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

async function buildProjectRepo(fileNames: string[]): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-curation-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (const name of fileNames) writeFileSync(join(projectRoot, name), `content of ${name}\n`);
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

interface AcceptedNoteSpec {
  id: string;
  body: string;
  anchors: string[];
  type?: NoteType;
  retired?: boolean;
  supersedes?: string;
}

// Notes land straight in notes/ as already-accepted history; the corpus repo gets one commit so the
// retire flow's own commit has a parent.
async function makeDeps(specs: AcceptedNoteSpec[], liveFiles: string[]): Promise<StagingDeps> {
  const { projectRoot, commit } = await buildProjectRepo(liveFiles);
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-curation-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  for (const spec of specs) {
    const frontmatter: NoteFrontmatter = {
      id: spec.id,
      type: spec.type ?? "decision",
      anchors: spec.anchors,
      commit,
      created: "2026-07-06T10:00:00.000Z",
    };
    if (spec.retired === true) frontmatter.retired = true;
    if (spec.supersedes !== undefined) frontmatter.supersedes = spec.supersedes;
    writeFileSync(join(corpus.notesDir, `${spec.id}.md`), serializeNote({ frontmatter, body: spec.body }));
  }
  await runGit(corpus.corpusDir, ["add", "-A"]);
  await runGit(corpus.corpusDir, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed notes", "--allow-empty",
  ]);
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-curation",
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

// Renames a committed project file the way a refactoring would, so the old path turns missing while
// git history carries the rename edge.
async function renameInProject(projectRoot: string, from: string, to: string): Promise<void> {
  await runGit(projectRoot, ["mv", from, to]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `rename ${from}`,
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
}

function noteOnDisk(corpus: Corpus, id: string) {
  return parseNote(readFileSync(join(corpus.notesDir, `${id}.md`), "utf8"));
}

describe("notesList", () => {
  test("lists live notes with anchor health and no bodies; dead anchors are counted", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "first line zero\nsecond line stays out of the listing", anchors: ["src/a.ts"] },
        { id: ulid(1), body: "note with a dead anchor", anchors: ["src/gone.ts", "src/a.ts"], type: "bugfix" },
      ],
      ["src/a.ts"],
    );

    const result = await notesList(deps, {});

    expect(result.total).toBe(2);
    expect(result.entries).toEqual([
      { id: ulid(0), type: "decision", firstLine: "first line zero", anchorsN: 1, deadN: 0 },
      { id: ulid(1), type: "bugfix", firstLine: "note with a dead anchor", anchorsN: 2, deadN: 1 },
    ]);
  });

  test("type and dead_anchors_only filters narrow the listing", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "healthy decision", anchors: ["src/a.ts"] },
        { id: ulid(1), body: "rotten bugfix", anchors: ["src/gone.ts"], type: "bugfix" },
        { id: ulid(2), body: "healthy bugfix", anchors: ["src/a.ts"], type: "bugfix" },
      ],
      ["src/a.ts"],
    );

    const byType = await notesList(deps, { type: "bugfix" });
    expect(byType.entries.map((entry) => entry.id)).toEqual([ulid(1), ulid(2)]);

    const deadOnly = await notesList(deps, { deadAnchorsOnly: true });
    expect(deadOnly.entries.map((entry) => entry.id)).toEqual([ulid(1)]);
    expect(deadOnly.total).toBe(1);
  });

  test("limit truncates the listing but total reports the full match count", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "note zero", anchors: ["src/a.ts"] },
        { id: ulid(1), body: "note one", anchors: ["src/a.ts"] },
        { id: ulid(2), body: "note two", anchors: ["src/a.ts"] },
      ],
      ["src/a.ts"],
    );

    const result = await notesList(deps, { limit: 2 });

    expect(result.entries.length).toBe(2);
    expect(result.total).toBe(3);
  });

  test("superseded and retired notes are not listed", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "old superseded note", anchors: ["src/a.ts"] },
        { id: ulid(1), body: "the successor", anchors: ["src/a.ts"], supersedes: ulid(0) },
        { id: ulid(2), body: "already retired", anchors: ["src/a.ts"], retired: true },
      ],
      ["src/a.ts"],
    );

    const result = await notesList(deps, {});

    expect(result.entries.map((entry) => entry.id)).toEqual([ulid(1)]);
  });

  test("showNote returns the full note by id and rejects a malformed id", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "first line\nfull body detail", anchors: ["src/a.ts"] }],
      ["src/a.ts"],
    );

    const note = showNote(deps.corpus, ulid(0));
    expect(note.body).toBe("first line\nfull body detail");

    expect(() => showNote(deps.corpus, "../evil")).toThrow(CurationError);
    expect(() => showNote(deps.corpus, ulid(9))).toThrow(/no note/);
  });
});

describe("note_retire through staging", () => {
  test("retire stages a request and only an accept rewrites the note, keeps the file, and drops it from the index", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "note to retire", anchors: ["src/a.ts"] },
        { id: ulid(1), body: "note that stays", anchors: ["src/a.ts"] },
      ],
      ["src/a.ts"],
    );

    const staged = noteRetire(deps, ulid(0), "example rotted away");
    expect(staged.targetId).toBe(ulid(0));
    expect(countStagedNotes(deps.corpus)).toBe(1);
    expect(listRetireRequests(deps.corpus)).toEqual([
      { requestId: staged.requestId, targetId: ulid(0), reason: "example rotted away" },
    ]);
    expect(eventsOfType(deps.corpus, "note_retire_staged").length).toBe(1);
    // Nothing is retired until the human decides.
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.retired).toBeUndefined();

    const result = await stagingResolve(deps, staged.requestId, "accept");

    expect(result.outcome).toBe("retired");
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.retired).toBe(true);
    expect(existsSync(join(deps.corpus.notesDir, `${ulid(0)}.md`))).toBe(true);
    expect(countStagedNotes(deps.corpus)).toBe(0);
    const resolved = eventsOfType(deps.corpus, "note_retire_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("accept");
    expect(resolved[0]!.target_id).toBe(ulid(0));
    // The rebuilt index holds only the survivor: retired notes leave recall and dedup by absence.
    const indexed = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string }>;
    expect(indexed.map((row) => row.id)).toEqual([ulid(1)]);
  });

  test("a rejected retire request leaves the note live and logs the refusal", async () => {
    const deps = await makeDeps([{ id: ulid(0), body: "note to keep", anchors: ["src/a.ts"] }], ["src/a.ts"]);
    const staged = noteRetire(deps, ulid(0), "second thoughts");

    const result = await stagingResolve(deps, staged.requestId, "reject");

    expect(result.outcome).toBe("retire_rejected");
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.retired).toBeUndefined();
    expect(listRetireRequests(deps.corpus)).toEqual([]);
    const resolved = eventsOfType(deps.corpus, "note_retire_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("reject");
    expect(resolved[0]!.commit).toBeNull();
  });

  test("a retire request refuses the supersede decision", async () => {
    const deps = await makeDeps([{ id: ulid(0), body: "note", anchors: ["src/a.ts"] }], ["src/a.ts"]);
    const staged = noteRetire(deps, ulid(0), "not a supersede");

    expect(stagingResolve(deps, staged.requestId, { supersede: ulid(0) })).rejects.toThrow(StagingError);
  });

  test("retire refuses unknown targets, duplicates, already-retired notes, and blank reasons", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "live note", anchors: ["src/a.ts"] },
        { id: ulid(2), body: "already retired", anchors: ["src/a.ts"], retired: true },
      ],
      ["src/a.ts"],
    );

    expect(() => noteRetire(deps, ulid(9), "no such note")).toThrow(/no note/);
    expect(() => noteRetire(deps, ulid(2), "again")).toThrow(/already retired/);
    expect(() => noteRetire(deps, ulid(0), "   ")).toThrow(/blank/);

    noteRetire(deps, ulid(0), "first request");
    expect(() => noteRetire(deps, ulid(0), "second request")).toThrow(/pending retire request/);
  });
});

describe("anchor_repair through staging", () => {
  test("reanchor stages a request and only an accept rewrites the anchors, commits, and re-indexes", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "note whose anchor moved", anchors: ["src/old.ts", "src/a.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");

    const staged = await noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", 97, "sweep");

    expect(staged.targetId).toBe(ulid(0));
    expect(countStagedNotes(deps.corpus)).toBe(1);
    expect(listReanchorRequests(deps.corpus)).toEqual([
      {
        requestId: staged.requestId,
        targetId: ulid(0),
        oldAnchor: "src/old.ts",
        newAnchor: "src/new.ts",
        score: 97,
        source: "sweep",
      },
    ]);
    const stagedEvents = eventsOfType(deps.corpus, "note_reanchor_staged");
    expect(stagedEvents.length).toBe(1);
    expect(stagedEvents[0]!.old_anchor).toBe("src/old.ts");
    expect(stagedEvents[0]!.new_anchor).toBe("src/new.ts");
    expect(stagedEvents[0]!.score).toBe(97);
    expect(stagedEvents[0]!.source).toBe("sweep");
    // Nothing changes until the human decides.
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.anchors).toEqual(["src/old.ts", "src/a.ts"]);
    const rendered = formatStagingList([], [], listReanchorRequests(deps.corpus));
    expect(rendered).toContain(`re-anchor request for note ${ulid(0)} (accept or reject only)`);
    expect(rendered).toContain("anchor: src/old.ts -> src/new.ts (rename score 97%)");

    const result = await stagingResolve(deps, staged.requestId, "accept");

    expect(result.outcome).toBe("reanchored");
    if (result.outcome === "reanchored") {
      expect(result.oldAnchor).toBe("src/old.ts");
      expect(result.newAnchor).toBe("src/new.ts");
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.anchors).toEqual(["src/new.ts", "src/a.ts"]);
    expect(countStagedNotes(deps.corpus)).toBe(0);
    const resolved = eventsOfType(deps.corpus, "note_reanchor_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("accept");
    expect(resolved[0]!.target_id).toBe(ulid(0));
    expect(resolved[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    const indexed = JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string }>;
    expect(indexed.map((row) => row.id)).toEqual([ulid(0)]);
  });

  test("a rejected re-anchor request leaves the note unchanged and logs the refusal", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "note kept as is", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");
    const staged = await noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", null, "manual");

    const result = await stagingResolve(deps, staged.requestId, "reject");

    expect(result.outcome).toBe("reanchor_rejected");
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.anchors).toEqual(["src/old.ts"]);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
    const resolved = eventsOfType(deps.corpus, "note_reanchor_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("reject");
    expect(resolved[0]!.commit).toBeNull();
  });

  test("a re-anchor request refuses the supersede decision", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "note", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");
    const staged = await noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", null, "manual");

    expect(stagingResolve(deps, staged.requestId, { supersede: ulid(0) })).rejects.toThrow(StagingError);
  });

  test("reanchor refuses a live old anchor, an untracked new anchor, retired notes, foreign anchors, and duplicates", async () => {
    const deps = await makeDeps(
      [
        { id: ulid(0), body: "live note", anchors: ["src/old.ts", "src/a.ts"] },
        { id: ulid(2), body: "already retired", anchors: ["src/old.ts"], retired: true },
      ],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");

    // src/a.ts is tracked, not missing — nothing to repair.
    await expect(noteReanchor(deps, ulid(0), "src/a.ts", "src/new.ts", null, "manual")).rejects.toThrow(/not missing/);
    // src/gone.ts is not tracked by the project's git — an invalid destination.
    await expect(noteReanchor(deps, ulid(0), "src/old.ts", "src/gone.ts", null, "manual")).rejects.toThrow(/not tracked/);
    await expect(noteReanchor(deps, ulid(2), "src/old.ts", "src/new.ts", null, "manual")).rejects.toThrow(/retired/);
    await expect(noteReanchor(deps, ulid(0), "src/other.ts", "src/new.ts", null, "manual")).rejects.toThrow(/does not anchor/);
    await expect(noteReanchor(deps, ulid(9), "src/old.ts", "src/new.ts", null, "manual")).rejects.toThrow(/no note/);

    await noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", null, "manual");
    await expect(noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", null, "manual")).rejects.toThrow(
      /pending re-anchor request/,
    );
  });

  test("accept re-validates the new anchor and keeps the request queued on failure", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "note whose successor vanished", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");
    const staged = await noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", null, "manual");
    // The tree moves between staging and the decision: the successor is deleted outright.
    await runGit(deps.projectRoot, ["rm", "-q", "src/new.ts"]);
    await runGit(deps.projectRoot, [
      "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "delete successor",
    ]);

    await expect(stagingResolve(deps, staged.requestId, "accept")).rejects.toThrow(/no longer tracked/);

    expect(listReanchorRequests(deps.corpus).map((request) => request.requestId)).toEqual([staged.requestId]);
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.anchors).toEqual(["src/old.ts"]);
  });

  test("accept converges after a crash that rewrote the anchors before committing", async () => {
    const deps = await makeDeps(
      [{ id: ulid(0), body: "crash between rewrite and commit", anchors: ["src/old.ts"] }],
      ["src/old.ts", "src/a.ts"],
    );
    await renameInProject(deps.projectRoot, "src/old.ts", "src/new.ts");
    const staged = await noteReanchor(deps, ulid(0), "src/old.ts", "src/new.ts", null, "manual");
    // Simulate the crash: the note file already carries the new anchor, the request still stands.
    const note = noteOnDisk(deps.corpus, ulid(0));
    writeFileSync(
      join(deps.corpus.notesDir, `${ulid(0)}.md`),
      serializeNote({ frontmatter: { ...note.frontmatter, anchors: ["src/new.ts"] }, body: note.body }),
    );

    const result = await stagingResolve(deps, staged.requestId, "accept");

    expect(result.outcome).toBe("reanchored");
    expect(noteOnDisk(deps.corpus, ulid(0)).frontmatter.anchors).toEqual(["src/new.ts"]);
    expect(listReanchorRequests(deps.corpus)).toEqual([]);
  });
});
