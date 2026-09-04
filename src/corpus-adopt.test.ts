import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config";
import { canonicalize, resolveCorpus } from "./corpus";
import type { Corpus } from "./corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { initRepo, runGit } from "./git";
import { rebuild } from "./index-db";
import { serializeNote } from "./note";
import type { StagingDeps } from "./staging";
import { adoptCorpus, CorpusAdoptError } from "./corpus-adopt";

// Adoption is exercised on REAL corpora: real resolveCorpus, real manifests read by the real
// readManifest, real corpus git and a real SQLite index. The only stand-in is the embedder, and it
// is deterministic (a bag-of-words vector) so "the same body" scores exactly 1.0 and the dedup
// verdicts are assertable rather than approximate.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

// Every test here drives real git repositories, a real SQLite index and a real corpus commit, so a
// single case legitimately costs seconds. The default 5s per-test cap turns a loaded machine into a
// coin flip on tests whose LOGIC is deterministic; the cap is raised rather than the work faked.
const ADOPT_TEST_TIMEOUT_MS = 30000;

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function hashTerm(term: string): number {
  let hash = 2166136261;
  for (let index = 0; index < term.length; index++) {
    hash ^= term.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const dimension = hashTerm(term) % EMBEDDING_DIMENSION;
    vector[dimension] = vector[dimension]! + 1;
  }
  return vector;
}

function bagOfWordsClient(): EmbeddingsClient {
  return { model: EMBEDDING_MODEL, embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
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

interface NoteSpec {
  id: string;
  body: string;
}

async function buildProjectRepo(prefix: string): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

// One accepted corpus: notes land straight in notes/ as history, committed the way an accept would
// have left them.
async function buildCorpus(specs: NoteSpec[]): Promise<{ corpus: Corpus; projectRoot: string }> {
  const { projectRoot, commit } = await buildProjectRepo("mneme-adopt-proj-");
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-adopt-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  for (const spec of specs) {
    writeFileSync(
      join(corpus.notesDir, `${spec.id}.md`),
      serializeNote({
        frontmatter: {
          id: spec.id,
          type: "decision",
          anchors: ["src/a.ts"],
          commit,
          created: "2026-07-06T10:00:00.000Z",
        },
        body: spec.body,
      }),
    );
  }
  await runGit(corpus.corpusDir, ["add", "-A"]);
  await runGit(corpus.corpusDir, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed notes", "--allow-empty",
  ]);
  return { corpus, projectRoot };
}

function makeDeps(
  corpus: Corpus,
  projectRoot: string,
  embeddings: EmbeddingsClient = bagOfWordsClient(),
): StagingDeps {
  return {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => ulid(900),
    embeddings,
    eventWriter: new EventWriter(corpus.eventsDir, {
      sessionId: "s-adopt",
      mnemeVersion: "0.1.0",
      clock: fixedClock,
    }),
  };
}

// The receiving corpus carries an INDEX only where the test is about dedup: that is the one question
// whose answer comes from the index (who the nearest neighbor is), and seeding it costs a full
// rebuild — real work this suite does enough of already.
async function receivingDeps(specs: NoteSpec[], indexed = false): Promise<StagingDeps> {
  const { corpus, projectRoot } = await buildCorpus(specs);
  const deps = makeDeps(corpus, projectRoot);
  if (indexed) {
    await rebuild({
      indexPath: corpus.indexPath,
      notesDir: corpus.notesDir,
      projectRoot,
      embeddings: deps.embeddings,
      eventWriter: deps.eventWriter,
      clock: fixedClock,
    });
  }
  return deps;
}

function noteIds(notesDir: string): string[] {
  return readdirSync(notesDir).filter((name) => name.endsWith(".md")).sort();
}

function adoptionEvents(corpus: Corpus): StoredEvent[] {
  return readEvents(corpus.eventsDir).filter((event) => event.type === "corpus_adopted");
}

async function headOf(corpus: Corpus): Promise<string> {
  return (await runGit(corpus.corpusDir, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("adopting a corpus that drifted apart", () => {
  test("new notes cross, are committed, and the pass is recorded as one event", async () => {
    const deps = await receivingDeps([{ id: ulid(1), body: "receiving corpus alpha knowledge" }]);
    const source = await buildCorpus([{ id: ulid(2), body: "source corpus beta wisdom" }]);
    const headBefore = await headOf(deps.corpus);

    const outcome = await adoptCorpus(deps, source.corpus.corpusDir);

    expect(outcome.adoptedCount).toBe(1);
    expect(outcome.skippedCount).toBe(0);
    expect(outcome.notes).toEqual([{ id: ulid(2), reason: "adopted" }]);
    expect(noteIds(deps.corpus.notesDir)).toEqual([`${ulid(1)}.md`, `${ulid(2)}.md`]);
    expect(readFileSync(join(deps.corpus.notesDir, `${ulid(2)}.md`), "utf8")).toContain("source corpus beta wisdom");
    expect(await headOf(deps.corpus)).not.toBe(headBefore);
    expect(outcome.commit).toBe(await headOf(deps.corpus));

    const events = adoptionEvents(deps.corpus);
    expect(events.length).toBe(1);
    expect(events[0]!.source_path).toBe(canonicalize(source.corpus.corpusDir));
    expect(events[0]!.adopted_n).toBe(1);
    expect(events[0]!.skipped_n).toBe(0);
    expect(events[0]!.type).toBe("corpus_adopted");
  }, ADOPT_TEST_TIMEOUT_MS);

  test("a note already present by id is skipped, and its receiving copy is left untouched", async () => {
    const shared = ulid(3);
    const deps = await receivingDeps([{ id: shared, body: "the receiving wording of one idea" }]);
    const source = await buildCorpus([{ id: shared, body: "a totally different wording of it" }]);
    const before = readFileSync(join(deps.corpus.notesDir, `${shared}.md`), "utf8");

    const outcome = await adoptCorpus(deps, source.corpus.corpusDir);

    expect(outcome.notes).toEqual([{ id: shared, reason: "already-present" }]);
    expect(outcome.adoptedCount).toBe(0);
    expect(outcome.skippedCount).toBe(1);
    expect(readFileSync(join(deps.corpus.notesDir, `${shared}.md`), "utf8")).toBe(before);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("a note the receiving corpus already knows under another id is skipped as a duplicate", async () => {
    const body = "dedup recognizes this exact knowledge already held here";
    const deps = await receivingDeps([{ id: ulid(4), body }], true);
    const source = await buildCorpus([
      { id: ulid(5), body },
      { id: ulid(6), body: "a genuinely new thought worth adopting" },
    ]);

    const outcome = await adoptCorpus(deps, source.corpus.corpusDir);

    expect(outcome.adoptedCount).toBe(1);
    expect(outcome.skippedCount).toBe(1);
    const duplicate = outcome.notes.find((note) => note.id === ulid(5))!;
    expect(duplicate.reason).toBe("duplicate");
    expect(duplicate.nearestId).toBe(ulid(4));
    expect(duplicate.similarity).toBeGreaterThanOrEqual(defaultConfig().dedup.noopThreshold);
    expect(existsSync(join(deps.corpus.notesDir, `${ulid(5)}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.notesDir, `${ulid(6)}.md`))).toBe(true);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("the source corpus is only read: its notes and its git history are unchanged", async () => {
    const deps = await receivingDeps([{ id: ulid(7), body: "receiving side" }]);
    const source = await buildCorpus([{ id: ulid(8), body: "source side worth adopting" }]);
    const idsBefore = noteIds(source.corpus.notesDir);
    const bodyBefore = readFileSync(join(source.corpus.notesDir, `${ulid(8)}.md`), "utf8");
    const headBefore = await headOf(source.corpus);

    await adoptCorpus(deps, source.corpus.corpusDir);

    expect(noteIds(source.corpus.notesDir)).toEqual(idsBefore);
    expect(readFileSync(join(source.corpus.notesDir, `${ulid(8)}.md`), "utf8")).toBe(bodyBefore);
    expect(await headOf(source.corpus)).toBe(headBefore);
  }, ADOPT_TEST_TIMEOUT_MS);
});

describe("adoption converges on retry", () => {
  test("a second adoption of the same source changes nothing", async () => {
    const deps = await receivingDeps([{ id: ulid(9), body: "receiving side" }]);
    const source = await buildCorpus([{ id: ulid(10), body: "source side worth adopting" }]);

    await adoptCorpus(deps, source.corpus.corpusDir);
    const headAfterFirst = await headOf(deps.corpus);
    const second = await adoptCorpus(deps, source.corpus.corpusDir);

    expect(second.adoptedCount).toBe(0);
    expect(second.notes).toEqual([{ id: ulid(10), reason: "already-present" }]);
    expect(second.commit).toBe(headAfterFirst);
    expect(await headOf(deps.corpus)).toBe(headAfterFirst);
    expect(noteIds(deps.corpus.notesDir)).toEqual([`${ulid(9)}.md`, `${ulid(10)}.md`]);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("a crash after the copy but before the commit is finished by the next run", async () => {
    const deps = await receivingDeps([{ id: ulid(11), body: "receiving side" }]);
    const source = await buildCorpus([{ id: ulid(12), body: "source side worth adopting" }]);
    // The state a crash between the copy step and the commit step leaves behind: the note file is in
    // notes/, nothing is committed.
    writeFileSync(
      join(deps.corpus.notesDir, `${ulid(12)}.md`),
      readFileSync(join(source.corpus.notesDir, `${ulid(12)}.md`), "utf8"),
    );
    const headBefore = await headOf(deps.corpus);

    const outcome = await adoptCorpus(deps, source.corpus.corpusDir);

    expect(outcome.notes).toEqual([{ id: ulid(12), reason: "already-present" }]);
    expect(outcome.commit).not.toBe(headBefore);
    const tracked = await runGit(deps.corpus.corpusDir, ["ls-files", `notes/${ulid(12)}.md`]);
    expect(tracked.stdout.trim()).toBe(`notes/${ulid(12)}.md`);
    const status = await runGit(deps.corpus.corpusDir, ["status", "--porcelain", "notes"]);
    expect(status.stdout.trim()).toBe("");
  }, ADOPT_TEST_TIMEOUT_MS);
});

describe("adoption refuses before it copies anything", () => {
  test("an unreachable embedder aborts the whole pass, leaving the corpus as it was", async () => {
    const { corpus, projectRoot } = await buildCorpus([{ id: ulid(13), body: "receiving side" }]);
    const deps = makeDeps(corpus, projectRoot, offlineClient());
    const source = await buildCorpus([{ id: ulid(14), body: "source side" }]);

    await expect(adoptCorpus(deps, source.corpus.corpusDir)).rejects.toThrow(CorpusAdoptError);
    expect(noteIds(corpus.notesDir)).toEqual([`${ulid(13)}.md`]);
    expect(adoptionEvents(corpus).length).toBe(0);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("a directory that is not a corpus is refused by the real manifest reader", async () => {
    const deps = await receivingDeps([{ id: ulid(15), body: "receiving side" }]);
    const notACorpus = mkdtempSync(join(tmpdir(), "mneme-adopt-bogus-"));

    await expect(adoptCorpus(deps, notACorpus)).rejects.toThrow(/not readable|manifest/);
    expect(noteIds(deps.corpus.notesDir)).toEqual([`${ulid(15)}.md`]);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("a corpus whose manifest predates this format is refused with the migration named", async () => {
    const deps = await receivingDeps([{ id: ulid(16), body: "receiving side" }]);
    const source = await buildCorpus([{ id: ulid(17), body: "source side" }]);
    const manifest = JSON.parse(readFileSync(source.corpus.manifestPath, "utf8"));
    writeFileSync(source.corpus.manifestPath, JSON.stringify({ ...manifest, format_version: 2 }));

    await expect(adoptCorpus(deps, source.corpus.corpusDir)).rejects.toThrow(/migrate its manifest/);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("adopting this project's own corpus is refused", async () => {
    const deps = await receivingDeps([{ id: ulid(18), body: "receiving side" }]);

    await expect(adoptCorpus(deps, deps.corpus.corpusDir)).rejects.toThrow(/corpus of this project/);
  }, ADOPT_TEST_TIMEOUT_MS);

  test("a source holding files that are not notes is refused before any copy", async () => {
    const deps = await receivingDeps([{ id: ulid(19), body: "receiving side" }]);
    const source = await buildCorpus([{ id: ulid(20), body: "source side" }]);
    writeFileSync(join(source.corpus.notesDir, "../evil.md"), "not a note id\n");
    writeFileSync(join(source.corpus.notesDir, "notes-backup.md"), "not a note id\n");

    await expect(adoptCorpus(deps, source.corpus.corpusDir)).rejects.toThrow(/not notes/);
    expect(noteIds(deps.corpus.notesDir)).toEqual([`${ulid(19)}.md`]);
  }, ADOPT_TEST_TIMEOUT_MS);
});
