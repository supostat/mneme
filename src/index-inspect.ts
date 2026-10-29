import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { FLOAT_BYTES } from "./embeddings";
import { missingIndexTables } from "./index-db";
import { DEAD_ANCHOR_SINK } from "./staleness";

// A read-only health snapshot of the index.db cache, used by the doctor to decide whether the index
// is present, structurally complete, and holding vectors. It NEVER rebuilds or mutates: a missing file
// is reported as absent, an incomplete schema as such, and the stored-vector dimension is derived from
// an actual vec blob (bytes / FLOAT_BYTES) since the index records the embedding model, not a dimension.

export interface IndexInspection {
  present: boolean;
  tables: string[];
  hasRequiredTables: boolean;
  noteCount: number;
  vectorCount: number;
  storedDimension: number | null;
  embeddingModel: string | null;
  sectionCount: number;
  sectionVectorCount: number;
  linkCount: number;
  // The map sections whose anchors the last rebuild found dead — the rebuild's own verdict read
  // back, so the doctor can name them without probing git itself.
  deadAnchorSectionIds: string[];
}

export function inspectIndex(indexPath: string): IndexInspection {
  if (!existsSync(indexPath)) {
    return absentInspection();
  }
  // The ONE reader that keeps SQLite's readonly flag instead of openReadOnlyDatabase: the doctor
  // must not write a single byte into the corpus, and the readwrite reader would recreate the
  // -wal/-shm sidecars of a WAL index. The price is that a WAL index whose sidecars are gone cannot
  // be opened here at all — the doctor reports that state from the file header instead of healing it.
  const database = new Database(indexPath, { readonly: true });
  try {
    const tables = tableNames(database);
    if (missingIndexTables(database).length > 0) {
      return { ...absentInspection(), present: true, tables };
    }
    return {
      present: true,
      tables,
      hasRequiredTables: true,
      noteCount: countRows(database, "meta"),
      vectorCount: countRows(database, "vec"),
      storedDimension: firstStoredDimension(database),
      embeddingModel: firstEmbeddingModel(database),
      sectionCount: countRows(database, "map_meta"),
      sectionVectorCount: countRows(database, "map_vec"),
      linkCount: countRows(database, "map_links"),
      deadAnchorSectionIds: deadAnchorSectionIds(database),
    };
  } finally {
    database.close();
  }
}

function absentInspection(): IndexInspection {
  return {
    present: false,
    tables: [],
    hasRequiredTables: false,
    noteCount: 0,
    vectorCount: 0,
    storedDimension: null,
    embeddingModel: null,
    sectionCount: 0,
    sectionVectorCount: 0,
    linkCount: 0,
    deadAnchorSectionIds: [],
  };
}

function tableNames(database: Database): string[] {
  const rows = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function countRows(database: Database, table: "meta" | "vec" | "map_meta" | "map_vec" | "map_links"): number {
  const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

// A note vector first, a section vector when no note has one: both populations are embedded by
// the same model, so either blob tells the stored dimension.
function firstStoredDimension(database: Database): number | null {
  for (const table of ["vec", "map_vec"] as const) {
    const row = database.query(`SELECT embedding FROM ${table} LIMIT 1`).get() as
      | { embedding: Uint8Array }
      | null;
    if (row !== null) return row.embedding.byteLength / FLOAT_BYTES;
  }
  return null;
}

function firstEmbeddingModel(database: Database): string | null {
  const row = database.query("SELECT embedding_model FROM index_config LIMIT 1").get() as
    | { embedding_model: string }
    | null;
  return row === null ? null : row.embedding_model;
}

function deadAnchorSectionIds(database: Database): string[] {
  const rows = database
    .query("SELECT id FROM map_meta WHERE staleness_boost = ? ORDER BY id")
    .all(DEAD_ANCHOR_SINK) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
