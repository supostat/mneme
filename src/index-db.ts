import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseNote } from "./note";
import type { Note } from "./note";
import { stalenessBoost, DEAD_ANCHOR_SINK } from "./staleness";
import { EMBEDDING_MODEL, cosineSimilarity, floatsFromBlob } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import type { EventInput, EventWriter } from "./events";

const SCHEMA_STATEMENTS = [
  "CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, body, tokenize = 'porter unicode61')",
  "CREATE TABLE meta (id TEXT PRIMARY KEY, type TEXT NOT NULL, staleness_boost REAL NOT NULL)",
  "CREATE TABLE vec (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding BLOB NOT NULL)",
  "CREATE TABLE index_config (embedding_model TEXT NOT NULL)",
];

export interface RebuildDeps {
  indexPath: string;
  notesDir: string;
  projectRoot: string;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
  clock: () => Date;
}

interface RebuildOutcome {
  notesCount: number;
  boosts: number[];
  available: boolean;
  retries: number;
  embeddedCount: number;
}

export async function rebuild(deps: RebuildDeps): Promise<void> {
  const startedAt = deps.clock().getTime();
  const outcome = await buildFreshIndex(deps);
  deps.eventWriter.append(rebuildEvent(startedAt, deps.clock().getTime(), outcome));
}

async function buildFreshIndex(deps: RebuildDeps): Promise<RebuildOutcome> {
  const cache = loadEmbeddingCache(deps.indexPath);
  rmSync(deps.indexPath, { force: true });
  const database = freshDatabase(deps.indexPath);
  try {
    const notes = readActiveNotes(deps.notesDir);
    const boosts = await insertFtsAndMeta(database, notes, deps.projectRoot);
    const vectors = await insertVectors(database, notes, cache, deps.embeddings);
    return { notesCount: notes.length, boosts, ...vectors };
  } finally {
    database.close();
  }
}

function rebuildEvent(startedAt: number, finishedAt: number, outcome: RebuildOutcome): EventInput {
  return {
    type: "rebuild",
    duration_ms: finishedAt - startedAt,
    notes_n: outcome.notesCount,
    embedded_n: outcome.embeddedCount,
    dead_anchors_n: outcome.boosts.filter((boost) => boost === DEAD_ANCHOR_SINK).length,
    staleness: outcome.boosts,
    ollama: { available: outcome.available, retries: outcome.retries },
  };
}

function freshDatabase(indexPath: string): Database {
  const database = new Database(indexPath, { create: true });
  for (const statement of SCHEMA_STATEMENTS) database.run(statement);
  return database;
}

function loadEmbeddingCache(indexPath: string): Map<string, Uint8Array> {
  if (!existsSync(indexPath)) return new Map();
  try {
    return readEmbeddingCache(indexPath);
  } catch {
    return new Map();
  }
}

function readEmbeddingCache(indexPath: string): Map<string, Uint8Array> {
  const database = new Database(indexPath, { readonly: true });
  try {
    const config = database.query("SELECT embedding_model FROM index_config").get() as
      | { embedding_model: string }
      | null;
    if (config?.embedding_model !== EMBEDDING_MODEL) return new Map();
    const cache = new Map<string, Uint8Array>();
    const rows = database.query("SELECT content_hash, embedding FROM vec").all() as Array<{
      content_hash: string;
      embedding: Uint8Array;
    }>;
    for (const row of rows) cache.set(row.content_hash, row.embedding);
    return cache;
  } finally {
    database.close();
  }
}

function readActiveNotes(notesDir: string): Note[] {
  const files = readdirSync(notesDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const notes = files.map((file) => parseNote(readFileSync(join(notesDir, file), "utf8")));
  const superseded = new Set(
    notes
      .map((note) => note.frontmatter.supersedes)
      .filter((id): id is string => id !== undefined),
  );
  return notes.filter((note) => !superseded.has(note.frontmatter.id));
}

async function insertFtsAndMeta(database: Database, notes: Note[], projectRoot: string): Promise<number[]> {
  const boosts = await Promise.all(
    notes.map((note) =>
      stalenessBoost(projectRoot, note.frontmatter.anchors, note.frontmatter.commit),
    ),
  );
  const insertFts = database.query("INSERT INTO fts(id, body) VALUES (?, ?)");
  const insertMeta = database.query("INSERT INTO meta(id, type, staleness_boost) VALUES (?, ?, ?)");
  const write = database.transaction(() => {
    notes.forEach((note, index) => {
      insertFts.run(note.frontmatter.id, note.body);
      insertMeta.run(note.frontmatter.id, note.frontmatter.type, boosts[index]!);
    });
  });
  write();
  return boosts;
}

interface VectorOutcome {
  available: boolean;
  retries: number;
  embeddedCount: number;
}

async function insertVectors(
  database: Database,
  notes: Note[],
  cache: Map<string, Uint8Array>,
  embeddings: EmbeddingsClient,
): Promise<VectorOutcome> {
  const bodies = [...new Set(notes.map((note) => note.body))];
  const hashByBody = new Map(bodies.map((body) => [body, sha256Hex(body)]));
  const toEmbed = bodies.filter((body) => !cache.has(hashByBody.get(body)!));
  const fresh = await embeddings.embed(toEmbed);
  const bytesByHash = resolveBytes(bodies, hashByBody, cache, toEmbed, fresh.available ? fresh.embeddings : []);
  const embeddedCount = writeVectors(database, notes, hashByBody, bytesByHash);
  return { available: fresh.available, retries: fresh.retries, embeddedCount };
}

function resolveBytes(
  bodies: string[],
  hashByBody: Map<string, string>,
  cache: Map<string, Uint8Array>,
  toEmbed: string[],
  freshEmbeddings: Float32Array[],
): Map<string, Uint8Array> {
  const bytesByHash = new Map<string, Uint8Array>();
  for (const body of bodies) {
    const cached = cache.get(hashByBody.get(body)!);
    if (cached !== undefined) bytesByHash.set(hashByBody.get(body)!, cached);
  }
  toEmbed.forEach((body, index) => {
    const vector = freshEmbeddings[index];
    if (vector !== undefined) bytesByHash.set(hashByBody.get(body)!, blobOf(vector));
  });
  return bytesByHash;
}

function writeVectors(
  database: Database,
  notes: Note[],
  hashByBody: Map<string, string>,
  bytesByHash: Map<string, Uint8Array>,
): number {
  const insertVec = database.query("INSERT INTO vec(id, content_hash, embedding) VALUES (?, ?, ?)");
  let written = 0;
  const write = database.transaction(() => {
    for (const note of notes) {
      const hash = hashByBody.get(note.body)!;
      const bytes = bytesByHash.get(hash);
      if (bytes === undefined) continue;
      insertVec.run(note.frontmatter.id, hash, bytes);
      written += 1;
    }
  });
  write();
  if (written > 0) database.run("INSERT INTO index_config(embedding_model) VALUES (?)", [EMBEDDING_MODEL]);
  return written;
}

function blobOf(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export interface NearestNeighbor {
  id: string;
  similarity: number;
}

export function nearestNeighbor(
  indexPath: string,
  queryVector: Float32Array,
): NearestNeighbor | undefined {
  if (!existsSync(indexPath)) return undefined;
  const database = new Database(indexPath, { readonly: true });
  try {
    const rows = database.query("SELECT id, embedding FROM vec").all() as Array<{
      id: string;
      embedding: Uint8Array;
    }>;
    let best: NearestNeighbor | undefined;
    for (const row of rows) {
      const vector = floatsFromBlob(row.embedding);
      if (vector === undefined) continue;
      const similarity = cosineSimilarity(queryVector, vector);
      if (best === undefined || similarity > best.similarity || (similarity === best.similarity && row.id < best.id)) {
        best = { id: row.id, similarity };
      }
    }
    return best;
  } finally {
    database.close();
  }
}

export function dumpIndex(indexPath: string): string {
  const database = new Database(indexPath, { readonly: true });
  try {
    const rows = database
      .query(
        "SELECT meta.id AS id, meta.type AS type, meta.staleness_boost AS staleness_boost, fts.body AS body" +
          " FROM meta JOIN fts ON fts.id = meta.id ORDER BY meta.id",
      )
      .all();
    return JSON.stringify(rows);
  } finally {
    database.close();
  }
}

export function dumpVectors(indexPath: string): string {
  const database = new Database(indexPath, { readonly: true });
  try {
    const rows = database
      .query("SELECT id, content_hash, hex(embedding) AS embedding FROM vec ORDER BY id")
      .all();
    return JSON.stringify(rows);
  } finally {
    database.close();
  }
}
