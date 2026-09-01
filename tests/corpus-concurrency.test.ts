import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCorpus } from "../src/corpus";
import { commitPaths, CorpusBusyError } from "../src/corpus-git";
import { scanEventLog, readEvents } from "../src/events";

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

async function runConcurrently(scriptPath: string, argumentLists: string[][]): Promise<void> {
  const processes = argumentLists.map((args) =>
    Bun.spawn({ cmd: ["bun", "run", scriptPath, ...args], stdout: "pipe", stderr: "pipe" }),
  );
  const outcomes = await Promise.all(
    processes.map(async (subprocess) => ({
      exitCode: await subprocess.exited,
      stderr: await new Response(subprocess.stderr).text(),
    })),
  );
  for (const outcome of outcomes) {
    expect(outcome.stderr).toBe("");
    expect(outcome.exitCode).toBe(0);
  }
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
