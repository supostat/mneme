import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCorpus } from "../src/corpus";
import { commitPaths, CorpusBusyError } from "../src/corpus-git";
import { EMBEDDING_DIMENSION } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter, scanEventLog, readEvents } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { dumpIndex, dumpVectors, rebuild } from "../src/index-db";
import { serializeNote } from "../src/note";
import type { Note } from "../src/note";

// Two working copies of one project now address ONE corpus, so two live sessions write to the same
// event log, the same index and the same git repo. These tests drive the three shared resources from
// REAL concurrent processes — an in-process loop would serialize on the single thread and prove
// nothing about what the operating system actually interleaves.

const REPO_ROOT = join(import.meta.dir, "..");
const WRITERS = 2;
const LINES_PER_WRITER = 60;

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Every process must exit clean; the returned stdouts (one per argument list, in order) let a test
// read what a process observed.
async function runConcurrently(scriptPaths: string | string[], argumentLists: string[][]): Promise<string[]> {
  const processes = argumentLists.map((args, index) => {
    const scriptPath = typeof scriptPaths === "string" ? scriptPaths : scriptPaths[index]!;
    return Bun.spawn({ cmd: ["bun", "run", scriptPath, ...args], stdout: "pipe", stderr: "pipe" });
  });
  const outcomes = await Promise.all(
    processes.map(async (subprocess) => ({
      exitCode: await subprocess.exited,
      stdout: await new Response(subprocess.stdout).text(),
      stderr: await new Response(subprocess.stderr).text(),
    })),
  );
  for (const outcome of outcomes) {
    expect(outcome.stderr).toBe("");
    expect(outcome.exitCode).toBe(0);
  }
  return outcomes.map((outcome) => outcome.stdout);
}

describe("event log with two live writers", () => {
  test("every appended line survives intact, with no torn or interleaved records", async () => {
    const eventsDir = tempDirectory("mneme-events-");
    const scriptPath = join(eventsDir, "append.ts");
    writeFileSync(
      scriptPath,
      `import { EventWriter } from ${JSON.stringify(join(REPO_ROOT, "src", "events.ts"))};
const [eventsDir, sessionId] = process.argv.slice(2);
const writer = new EventWriter(eventsDir!, {
  sessionId: sessionId!,
  clock: () => new Date("2026-09-01T00:00:00.000Z"),
  mnemeVersion: "0.1.7",
});
for (let index = 0; index < ${LINES_PER_WRITER}; index++) {
  writer.append({ type: "concurrency_probe", index, filler: "x".repeat(4096) });
}
`,
    );

    await runConcurrently(scriptPath, [
      [eventsDir, "session-a"],
      [eventsDir, "session-b"],
    ]);

    const scan = scanEventLog(eventsDir);
    expect(scan.corruptLineCount).toBe(0);
    expect(scan.eventCount).toBe(WRITERS * LINES_PER_WRITER);
    const events = readEvents(eventsDir);
    for (const sessionId of ["session-a", "session-b"]) {
      const written = events.filter((event) => event.session_id === sessionId);
      expect(written.length).toBe(LINES_PER_WRITER);
      expect(new Set(written.map((event) => event.index)).size).toBe(LINES_PER_WRITER);
      expect(written.every((event) => (event.filler as string).length === 4096)).toBe(true);
    }
  });
});

describe("index cache with two live writers", () => {
  test("concurrent writers wait for each other instead of failing with SQLITE_BUSY", async () => {
    const indexDirectory = tempDirectory("mneme-index-");
    const indexPath = join(indexDirectory, "index.db");
    const scriptPath = join(indexDirectory, "write.ts");
    const creator = new Database(indexPath, { create: true });
    creator.run("PRAGMA journal_mode = WAL");
    creator.run("CREATE TABLE probe (writer TEXT NOT NULL, seq INTEGER NOT NULL)");
    creator.close();
    writeFileSync(
      scriptPath,
      `import { Database } from "bun:sqlite";
const [indexPath, writer] = process.argv.slice(2);
const database = new Database(indexPath!, { create: true });
database.run("PRAGMA busy_timeout = 5000");
database.run("PRAGMA journal_mode = WAL");
const insert = database.query("INSERT INTO probe(writer, seq) VALUES (?, ?)");
for (let seq = 0; seq < ${LINES_PER_WRITER}; seq++) {
  database.transaction(() => insert.run(writer!, seq))();
}
database.close();
`,
    );

    await runConcurrently(scriptPath, [
      [indexPath, "writer-a"],
      [indexPath, "writer-b"],
    ]);

    const reader = new Database(indexPath, { readonly: true });
    reader.run("PRAGMA busy_timeout = 5000");
    const rows = reader.query("SELECT writer, COUNT(*) AS written FROM probe GROUP BY writer").all() as Array<{
      writer: string;
      written: number;
    }>;
    reader.close();
    expect(rows).toEqual([
      { writer: "writer-a", written: LINES_PER_WRITER },
      { writer: "writer-b", written: LINES_PER_WRITER },
    ]);
  });

  test("the writable open leaves the index in WAL mode, readable by a second connection", async () => {
    const corpusHome = tempDirectory("mneme-home-");
    const projectRoot = tempDirectory("mneme-project-");
    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const writer = new Database(corpus.indexPath, { create: true });
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("CREATE TABLE probe (id INTEGER)");
    writer.run("INSERT INTO probe(id) VALUES (1)");

    const reader = new Database(corpus.indexPath, { readonly: true });
    const mode = reader.query("PRAGMA journal_mode").get() as { journal_mode: string };
    const rows = reader.query("SELECT id FROM probe").all();
    reader.close();
    writer.close();

    expect(mode.journal_mode).toBe("wal");
    expect(rows).toEqual([{ id: 1 }]);
  });
});

// The rebuild rewrites the index IN PLACE inside one short IMMEDIATE transaction. Two processes
// rebuilding at once must serialize on that transaction and a third process reading the whole
// time must never see an error, a half-written table, or a failed integrity check — the failure
// modes the old delete-and-recreate rebuild produced ("disk I/O error" on the other session's
// connection, an empty 4096-byte file). The embedder stand-in sleeps so the two writers really
// overlap; the notes are anchor-neutral so the git scan does not dominate the timing.
const REBUILD_NOTES = 12;
const REBUILD_SLEEP_MS = 300;
const READER_DURATION_MS = 1500;
const READER_INTERVAL_MS = 25;
const SEED_MODEL = "seed-model";
const WRITER_MODEL = "writer-model";
const fixedClock = () => new Date("2026-09-04T10:00:00.000Z");

function noteId(index: number): string {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + crockford[Math.floor(index / 32) % 32]! + crockford[index % 32]!;
}

function instantClient(model: string): EmbeddingsClient {
  return {
    model,
    embed: async (inputs) => ({
      available: true,
      embeddings: inputs.map(() => new Float32Array(EMBEDDING_DIMENSION).fill(0.01)),
      retries: 0,
    }),
  };
}

async function projectWithOneCommit(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = tempDirectory("mneme-rebuild-project-");
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return { projectRoot, commit: (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim() };
}

describe("index rebuild with two live writers and a reader", () => {
  test(
    "two processes rebuilding at once serialize cleanly while a third process never sees a broken index",
    async () => {
      const { projectRoot, commit } = await projectWithOneCommit();
      const corpusHome = tempDirectory("mneme-rebuild-home-");
      const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
      for (let index = 0; index < REBUILD_NOTES; index++) {
        const note: Note = {
          frontmatter: { id: noteId(index), type: "pattern", anchors: ["src/a.ts"], commit, created: "2026-09-04T10:00:00.000Z" },
          body: `rebuild probe body ${index}`,
        };
        writeFileSync(join(corpus.notesDir, `${note.frontmatter.id}.md`), serializeNote(note));
      }
      const seedEventsDir = tempDirectory("mneme-rebuild-seed-events-");
      await rebuild({
        indexPath: corpus.indexPath,
        notesDir: corpus.notesDir,
        projectRoot,
        embeddings: instantClient(SEED_MODEL),
        eventWriter: new EventWriter(seedEventsDir, { sessionId: "seed", mnemeVersion: "0.1.0", clock: fixedClock }),
        clock: fixedClock,
      });
      const seeded = dumpIndex(corpus.indexPath);
      const scriptsDir = tempDirectory("mneme-rebuild-scripts-");
      const writerScript = join(scriptsDir, "rebuild.ts");
      const readerScript = join(scriptsDir, "read.ts");
      writeFileSync(
        writerScript,
        `import { rebuild } from ${JSON.stringify(join(REPO_ROOT, "src", "index-db.ts"))};
import { EventWriter } from ${JSON.stringify(join(REPO_ROOT, "src", "events.ts"))};
import { EMBEDDING_DIMENSION } from ${JSON.stringify(join(REPO_ROOT, "src", "embeddings.ts"))};
const [indexPath, notesDir, projectRoot, eventsDir, sessionId] = process.argv.slice(2);
const clock = () => new Date("2026-09-04T10:00:00.000Z");
// Sleeps before answering so the two writers are guaranteed to overlap in their slow phase.
const sleepyEmbedder = {
  model: ${JSON.stringify(WRITER_MODEL)},
  embed: async (inputs: string[]) => {
    await Bun.sleep(${REBUILD_SLEEP_MS});
    return { available: true, embeddings: inputs.map(() => new Float32Array(EMBEDDING_DIMENSION).fill(0.02)), retries: 0 };
  },
};
await rebuild({
  indexPath: indexPath!,
  notesDir: notesDir!,
  projectRoot: projectRoot!,
  embeddings: sleepyEmbedder,
  eventWriter: new EventWriter(eventsDir!, { sessionId: sessionId!, mnemeVersion: "0.1.0", clock }),
  clock,
});
`,
      );
      writeFileSync(
        readerScript,
        `import { openReadOnlyDatabase } from ${JSON.stringify(join(REPO_ROOT, "src", "index-db.ts"))};
const [indexPath, expectedNotes] = process.argv.slice(2);
const anomalies: string[] = [];
const deadline = Date.now() + ${READER_DURATION_MS};
let ticks = 0;
while (Date.now() < deadline) {
  ticks += 1;
  try {
    const database = openReadOnlyDatabase(indexPath!);
    try {
      const count = (database.query("SELECT COUNT(*) AS count FROM meta").get() as { count: number }).count;
      if (count !== Number(expectedNotes)) anomalies.push("count " + count);
      const integrity = (database.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      if (integrity !== "ok") anomalies.push("integrity " + integrity);
    } finally {
      database.close();
    }
  } catch (error) {
    anomalies.push("error " + String(error));
  }
  await Bun.sleep(${READER_INTERVAL_MS});
}
console.log(JSON.stringify({ ticks, anomalies }));
`,
      );

      const [, , readerStdout] = await runConcurrently(
        [writerScript, writerScript, readerScript],
        [
          [corpus.indexPath, corpus.notesDir, projectRoot, corpus.eventsDir, "writer-a"],
          [corpus.indexPath, corpus.notesDir, projectRoot, corpus.eventsDir, "writer-b"],
          [corpus.indexPath, String(REBUILD_NOTES)],
        ],
      );

      const observed = JSON.parse(readerStdout!) as { ticks: number; anomalies: string[] };
      expect(observed.anomalies).toEqual([]);
      expect(observed.ticks).toBeGreaterThan(10);
      const rebuilds = readEvents(corpus.eventsDir).filter((event) => event.type === "rebuild");
      expect(rebuilds.map((event) => event.session_id).sort()).toEqual(["writer-a", "writer-b"]);
      expect(dumpIndex(corpus.indexPath)).toBe(seeded);
      expect(JSON.parse(dumpVectors(corpus.indexPath))).toHaveLength(REBUILD_NOTES);
    },
    30000,
  );
});

describe("corpus commits under a held git lock", () => {
  async function corpusWithNote(): Promise<Awaited<ReturnType<typeof resolveCorpus>>> {
    const corpusHome = tempDirectory("mneme-home-");
    const projectRoot = tempDirectory("mneme-project-");
    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    writeFileSync(join(corpus.notesDir, "note.md"), "a note\n");
    return corpus;
  }

  test("a lock held by another session is a named busy error, and a retry converges once it lifts", async () => {
    const corpus = await corpusWithNote();
    const lockPath = join(corpus.corpusDir, ".git", "index.lock");
    mkdirSync(join(corpus.corpusDir, ".git"), { recursive: true });
    writeFileSync(lockPath, "");

    await expect(commitPaths(corpus, ["notes/note.md"], "add note")).rejects.toThrow(CorpusBusyError);
    await expect(commitPaths(corpus, ["notes/note.md"], "add note")).rejects.toThrow(
      "another session is committing to this corpus; retry",
    );

    rmSync(lockPath);
    const head = await commitPaths(corpus, ["notes/note.md"], "add note");

    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(lockPath)).toBe(false);
  });
});
