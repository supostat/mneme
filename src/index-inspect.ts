import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { FLOAT_BYTES } from "./embeddings";

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
}

const REQUIRED_INDEX_TABLES = ["fts", "meta", "vec", "index_config"] as const;

export function inspectIndex(indexPath: string): IndexInspection {
  if (!existsSync(indexPath)) {
    return absentInspection();
  }
  const database = new Database(indexPath, { readonly: true });
  try {
    const tables = tableNames(database);
    if (!REQUIRED_INDEX_TABLES.every((name) => tables.includes(name))) {
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
  };
}

function tableNames(database: Database): string[] {
  const rows = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function countRows(database: Database, table: "meta" | "vec"): number {
  const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function firstStoredDimension(database: Database): number | null {
  const row = database.query("SELECT embedding FROM vec LIMIT 1").get() as
    | { embedding: Uint8Array }
    | null;
  if (row === null) return null;
  return row.embedding.byteLength / FLOAT_BYTES;
}

function firstEmbeddingModel(database: Database): string | null {
  const row = database.query("SELECT embedding_model FROM index_config LIMIT 1").get() as
    | { embedding_model: string }
    | null;
  return row === null ? null : row.embedding_model;
}
