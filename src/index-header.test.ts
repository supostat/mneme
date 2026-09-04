import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIndexJournalMode, walSidecarsPresent } from "./index-header";

// The header reader is pinned against two kinds of file: a WAL database a real SQLite writer
// produced, and synthetic files whose only truth is their length and bytes 18-19. The synthetic
// ones keep the test from driving a real database through a journal-mode switch, and they are
// what makes the rollback and short-file cases deterministic on every SQLite build.

const HEADER_LENGTH = 100;
const WRITE_VERSION_OFFSET = 18;
const READ_VERSION_OFFSET = 19;

function scratchPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "mneme-index-header-")), name);
}

function writeWalDatabase(path: string): void {
  const database = new Database(path, { create: true });
  try {
    database.run("PRAGMA journal_mode = WAL");
    database.run("CREATE TABLE probe (id INTEGER)");
  } finally {
    database.close();
  }
}

function writeSyntheticHeader(path: string, writeVersion: number, readVersion: number): void {
  const bytes = new Uint8Array(HEADER_LENGTH);
  bytes[WRITE_VERSION_OFFSET] = writeVersion;
  bytes[READ_VERSION_OFFSET] = readVersion;
  writeFileSync(path, bytes);
}

describe("readIndexJournalMode", () => {
  test("a database a real writer switched to WAL reads as wal", () => {
    const path = scratchPath("real.db");
    writeWalDatabase(path);

    expect(readIndexJournalMode(path)).toBe("wal");
  });

  test("synthetic header bytes 2,2 read as wal and 1,1 as rollback", () => {
    const walPath = scratchPath("wal.db");
    const rollbackPath = scratchPath("rollback.db");
    writeSyntheticHeader(walPath, 2, 2);
    writeSyntheticHeader(rollbackPath, 1, 1);

    expect(readIndexJournalMode(walPath)).toBe("wal");
    expect(readIndexJournalMode(rollbackPath)).toBe("rollback");
  });

  test("a file shorter than the header, a missing file, and mixed versions read as unknown", () => {
    const shortPath = scratchPath("short.db");
    writeFileSync(shortPath, new Uint8Array(10));
    const mixedPath = scratchPath("mixed.db");
    writeSyntheticHeader(mixedPath, 2, 1);

    expect(readIndexJournalMode(shortPath)).toBe("unknown");
    expect(readIndexJournalMode(scratchPath("missing.db"))).toBe("unknown");
    expect(readIndexJournalMode(mixedPath)).toBe("unknown");
  });
});

describe("walSidecarsPresent", () => {
  test("true only while BOTH -wal and -shm exist next to the database", () => {
    const path = scratchPath("index.db");
    writeSyntheticHeader(path, 2, 2);
    writeFileSync(`${path}-wal`, "");
    writeFileSync(`${path}-shm`, "");
    expect(walSidecarsPresent(path)).toBe(true);

    rmSync(`${path}-shm`);
    expect(walSidecarsPresent(path)).toBe(false);

    rmSync(`${path}-wal`);
    expect(walSidecarsPresent(path)).toBe(false);
  });
});
