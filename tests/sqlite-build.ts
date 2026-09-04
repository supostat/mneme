import { Database } from "bun:sqlite";

// bun links the system SQLite on macOS — its source id ends in "aapl". That build keeps a WAL
// database's -wal/-shm sidecars on close and refuses a readonly open without them; the upstream
// build (CI's ubuntu bun) deletes the sidecars when the last connection closes and lets a readonly
// reader recreate them. Every test whose expectation depends on that contrast asks this ONE probe.
export function isAppleSqlite(): boolean {
  const probe = new Database(":memory:");
  try {
    const row = probe.query("SELECT sqlite_source_id() AS id").get() as { id: string };
    return row.id.endsWith("aapl");
  } finally {
    probe.close();
  }
}
