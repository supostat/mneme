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
import { CurationError, listRetireRequests, noteRetire, notesList, showNote } from "./curation";

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
