import { closeSync, existsSync, openSync, readSync } from "node:fs";

// The SQLite file header carries the journal mode in two bytes: offset 18 is the file-format write
// version and offset 19 the read version — 1 means a rollback journal, 2 means WAL. Reading them is
// the only way to tell a WAL database apart WITHOUT opening it, and the doctor must not open a WAL
// index whose -wal/-shm sidecars are gone: a readonly open fails outright and a writable one would
// recreate the sidecars, which is a write into the corpus. This module therefore reads twenty
// bytes and looks for two files; it never opens the database.

const HEADER_BYTES = 20;
const WRITE_VERSION_OFFSET = 18;
const READ_VERSION_OFFSET = 19;
const ROLLBACK_JOURNAL_VERSION = 1;
const WAL_JOURNAL_VERSION = 2;

export type IndexJournalMode = "wal" | "rollback" | "unknown";

export function readIndexJournalMode(indexPath: string): IndexJournalMode {
  const header = readHeader(indexPath);
  if (header === null) {
    return "unknown";
  }
  const writeVersion = header[WRITE_VERSION_OFFSET];
  const readVersion = header[READ_VERSION_OFFSET];
  if (writeVersion === WAL_JOURNAL_VERSION && readVersion === WAL_JOURNAL_VERSION) {
    return "wal";
  }
  if (writeVersion === ROLLBACK_JOURNAL_VERSION && readVersion === ROLLBACK_JOURNAL_VERSION) {
    return "rollback";
  }
  return "unknown";
}

// A WAL database is openable read-only only while BOTH sidecars exist; one without the other is
// the same broken state as none.
export function walSidecarsPresent(indexPath: string): boolean {
  return existsSync(`${indexPath}-wal`) && existsSync(`${indexPath}-shm`);
}

// The first twenty bytes, or null when the file is missing, unreadable, or shorter than a header.
function readHeader(indexPath: string): Uint8Array | null {
  let descriptor: number;
  try {
    descriptor = openSync(indexPath, "r");
  } catch {
    return null;
  }
  try {
    const header = new Uint8Array(HEADER_BYTES);
    const bytesRead = readSync(descriptor, header, 0, HEADER_BYTES, 0);
    return bytesRead === HEADER_BYTES ? header : null;
  } finally {
    closeSync(descriptor);
  }
}
