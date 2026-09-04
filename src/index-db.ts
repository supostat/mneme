import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseNote } from "./note";
import type { Note } from "./note";
import { isAnchorNeutral } from "./note";
import { stalenessBoost, DEAD_ANCHOR_SINK } from "./staleness";
import { createLivenessContext } from "./anchor-liveness";
import {
  REBUILD_EMBED_ATTEMPTS,
  REBUILD_EMBED_CHUNK_SIZE,
  REBUILD_EMBED_TIMEOUT_MS,
  cosineSimilarity,
  floatsFromBlob,
} from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import type { EventInput, EventWriter } from "./events";

// IF NOT EXISTS is what lets a rebuild open whatever is at the index path — a healthy index, an
// empty file, a file with half the tables — and heal the schema in place instead of recreating the
// file. The one state it cannot heal is a file that is not a database at all (see
// openIndexForRebuild).
const SCHEMA_STATEMENTS = [
  "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, body, tokenize = 'porter unicode61')",
  "CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, type TEXT NOT NULL, staleness_boost REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS vec (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding BLOB NOT NULL)",
  "CREATE TABLE IF NOT EXISTS index_config (embedding_model TEXT NOT NULL)",
];
const INDEX_TABLES = ["fts", "meta", "vec", "index_config"] as const;
const NOT_A_DATABASE_CODE = "SQLITE_NOTADB";

export interface RebuildDeps {
  indexPath: string;
  notesDir: string;
  projectRoot: string;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
  clock: () => Date;
}

interface RebuildOutcome extends VectorOutcome {
  notesCount: number;
  boosts: number[];
}

export async function rebuild(deps: RebuildDeps): Promise<void> {
  const startedAt = deps.clock().getTime();
  const outcome = await rebuildInPlace(deps);
  deps.eventWriter.append(rebuildEvent(startedAt, deps.clock().getTime(), outcome));
}

// The index file is never deleted under other sessions' connections: a connection whose file was
// unlinked or replaced fails every later statement with SQLITE_IOERR ("disk I/O error"), and a
// renamed-in replacement inherits a non-empty -wal from the old file and corrupts. Instead the
// existing file is opened, its schema healed, and its CONTENTS swapped inside one short IMMEDIATE
// transaction: readers on any connection see the old index or the new one, never a mix, and a
// second rebuild waits on BEGIN IMMEDIATE for the first to commit. Everything slow — reading the
// notes, the git anchor scan, the embedder round-trips — happens BEFORE that transaction, so the
// write lock is held for milliseconds, well inside every connection's busy timeout.
async function rebuildInPlace(deps: RebuildDeps): Promise<RebuildOutcome> {
  const database = openIndexForRebuild(deps.indexPath);
  try {
    const cache = readEmbeddingCache(database, deps.embeddings.model);
    const notes = readActiveNotes(deps.notesDir);
    const boosts = await stalenessBoosts(notes, deps.projectRoot);
    const vectors = await embedBodies(notes, cache, deps.embeddings);
    const embeddedCount = replaceIndexContents(database, notes, boosts, vectors, deps.embeddings.model);
    return { notesCount: notes.length, boosts, embeddedCount, ...vectors.outcome };
  } finally {
    database.close();
  }
}

function replaceIndexContents(
  database: Database,
  notes: Note[],
  boosts: number[],
  vectors: VectorPlan,
  model: string,
): number {
  const insertFts = database.query("INSERT INTO fts(id, body) VALUES (?, ?)");
  const insertMeta = database.query("INSERT INTO meta(id, type, staleness_boost) VALUES (?, ?, ?)");
  const swap = database.transaction((): number => {
    for (const table of INDEX_TABLES) database.run(`DELETE FROM ${table}`);
    notes.forEach((note, index) => {
      insertFts.run(note.frontmatter.id, ftsDocument(note));
      insertMeta.run(note.frontmatter.id, note.frontmatter.type, boosts[index]!);
    });
    return writeVectors(database, notes, vectors.hashByBody, vectors.bytesByHash, model);
  });
  return swap.immediate();
}

function rebuildEvent(startedAt: number, finishedAt: number, outcome: RebuildOutcome): EventInput {
  return {
    type: "rebuild",
    duration_ms: finishedAt - startedAt,
    notes_n: outcome.notesCount,
    embedded_n: outcome.embeddedCount,
    bodies_n: outcome.bodiesCount,
    chunks_n: outcome.chunksCount,
    chunks_ok_n: outcome.chunksOkCount,
    dead_anchors_n: outcome.boosts.filter((boost) => boost === DEAD_ANCHOR_SINK).length,
    staleness: outcome.boosts,
    ollama: { available: outcome.available, retries: outcome.retries },
  };
}

// Two live sessions can share one corpus, so every connection is opened for company. WAL is a
// property of the DATABASE FILE — the writable connection sets it once and it persists, letting a
// reader run while the writer commits; busy_timeout is a property of the CONNECTION and must be set
// on each one, so a contended access waits instead of failing instantly with SQLITE_BUSY. A
// read-only connection cannot switch the journal mode (that write belongs to the writer), which is
// why only the writable open carries the WAL pragma. ORDER MATTERS: busy_timeout comes FIRST,
// because switching the journal mode itself takes an exclusive lock — two sessions opening the index
// at the same moment make the WAL pragma the one unprotected step, and it fails with
// SQLITE_BUSY_RECOVERY unless the timeout is already armed.
//
// Readers do NOT use SQLite's readonly flag. A WAL database needs its -shm sidecar to be opened, and
// a readonly connection is not allowed to create one — so an index whose sidecars were removed
// (an upstream sqlite3 CLI deletes them on close; the engine's own Apple build keeps them) fails
// with SQLITE_CANTOPEN on every read. Readers therefore open readwrite so the sidecars can be
// recreated, refuse to CREATE the database (create: false — a missing index.db must stay missing,
// because existsSync on it is the "rebuild first" signal for recall and the doctor), and lock the
// connection with query_only so no SQL write can slip through. That guarantee is procedural rather
// than file-level: query_only still lets the connection create sidecars and run a checkpoint, and
// no reader in this codebase does either.
const BUSY_TIMEOUT_MS = 5000;

function openWritableDatabase(indexPath: string): Database {
  const database = new Database(indexPath, { create: true });
  try {
    database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.run("PRAGMA journal_mode = WAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

// Opens the index for a rebuild, healing its schema in place. The constructor never reads the
// file; the first statement that does is the WAL pragma, and on a file that is not a database it
// fails with SQLITE_NOTADB. Such a file can have no live connections (they would all fail the same
// way), so deleting it together with its -wal/-shm and starting over is safe — the only case where
// a rebuild removes the index file at all.
function openIndexForRebuild(indexPath: string): Database {
  try {
    return openIndexWithSchema(indexPath);
  } catch (error) {
    if (!isNotADatabase(error)) throw error;
    for (const path of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) rmSync(path, { force: true });
    return openIndexWithSchema(indexPath);
  }
}

function openIndexWithSchema(indexPath: string): Database {
  const database = openWritableDatabase(indexPath);
  try {
    for (const statement of SCHEMA_STATEMENTS) database.run(statement);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function isNotADatabase(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === NOT_A_DATABASE_CODE;
}

export function openReadOnlyDatabase(indexPath: string): Database {
  const database = new Database(indexPath, { readwrite: true, create: false });
  database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.run("PRAGMA query_only = 1");
  return database;
}

// The vector cache is read from the SAME connection the rebuild will write through, before its
// transaction: a snapshot of whatever the last committed rebuild left, stamped with its model. A
// stamp from another model — or no stamp, the mark of an index that never got a vector — empties
// the cache, so every body is embedded afresh.
function readEmbeddingCache(database: Database, model: string): Map<string, Uint8Array> {
  const config = database.query("SELECT embedding_model FROM index_config").get() as
    | { embedding_model: string }
    | null;
  if (config?.embedding_model !== model) return new Map();
  const cache = new Map<string, Uint8Array>();
  const rows = database.query("SELECT content_hash, embedding FROM vec").all() as Array<{
    content_hash: string;
    embedding: Uint8Array;
  }>;
  for (const row of rows) cache.set(row.content_hash, row.embedding);
  return cache;
}

// The single definition of "active": not superseded and not retired. Rebuild indexes exactly this
// population, so retired notes leave recall AND dedup neighborhoods by never being indexed; the
// curation listing imports the same function so the two populations cannot drift.
export function readActiveNotes(notesDir: string): Note[] {
  const files = readdirSync(notesDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const notes = files.map((file) => parseNote(readFileSync(join(notesDir, file), "utf8")));
  const superseded = new Set(
    notes
      .map((note) => note.frontmatter.supersedes)
      .filter((id): id is string => id !== undefined),
  );
  return notes.filter((note) => !superseded.has(note.frontmatter.id) && note.frontmatter.retired !== true);
}

// An anchor-neutral note (pattern, antipattern) is pinned to the neutral 0 boost — the same value a
// fresh at-HEAD anchor earns — so example rot never sinks it; the git anchor scan is skipped
// entirely for these types. A note with ZERO path anchors (tags-only) earns the same neutral pin:
// it has no code address to go stale, and stalenessBoost on an empty array would be Math.min() of
// nothing = Infinity. Every other case keeps the pinned staleness formula unchanged.
const ANCHOR_NEUTRAL_STALENESS_BOOST = 0;

// The FTS document is body plus tags: tags earn FTS rank (their only retrieval channel) while the
// returned body — and the vector/dedup key — stays the pure note body.
function ftsDocument(note: Note): string {
  const tags = note.frontmatter.tags;
  return tags === undefined ? note.body : `${note.body}\n${tags.join("\n")}`;
}

// The git anchor scan, done once per rebuild and entirely outside the write transaction. The
// branch-tips map is built ONCE; per-note scoring only does lookups.
async function stalenessBoosts(notes: Note[], projectRoot: string): Promise<number[]> {
  const context = await createLivenessContext(projectRoot);
  return Promise.all(
    notes.map((note) =>
      isAnchorNeutral(note.frontmatter.type) || note.frontmatter.anchors.length === 0
        ? ANCHOR_NEUTRAL_STALENESS_BOOST
        : stalenessBoost(context, note.frontmatter.anchors, note.frontmatter.commit),
    ),
  );
}

interface VectorOutcome {
  available: boolean;
  retries: number;
  embeddedCount: number;
  bodiesCount: number;
  chunksCount: number;
  chunksOkCount: number;
}

// Everything the transaction needs to write the vec table, computed beforehand: the embedder
// round-trips are the slowest part of a rebuild and must not run under the write lock.
interface VectorPlan {
  hashByBody: Map<string, string>;
  bytesByHash: Map<string, Uint8Array>;
  outcome: Omit<VectorOutcome, "embeddedCount">;
}

async function embedBodies(notes: Note[], cache: Map<string, Uint8Array>, embeddings: EmbeddingsClient): Promise<VectorPlan> {
  const bodies = [...new Set(notes.map((note) => note.body))];
  const hashByBody = new Map(bodies.map((body) => [body, sha256Hex(body)]));
  const toEmbed = bodies.filter((body) => !cache.has(hashByBody.get(body)!));
  const fresh = await embedInChunks(embeddings, toEmbed);
  const bytesByHash = resolveBytes(bodies, hashByBody, cache, toEmbed, fresh.embeddings);
  return {
    hashByBody,
    bytesByHash,
    outcome: {
      available: fresh.available,
      retries: fresh.retries,
      bodiesCount: toEmbed.length,
      chunksCount: fresh.chunksCount,
      chunksOkCount: fresh.chunksOkCount,
    },
  };
}

interface ChunkedEmbedding {
  embeddings: Float32Array[];
  available: boolean;
  retries: number;
  chunksCount: number;
  chunksOkCount: number;
}

// Bodies go to the embedder chunk by chunk, so one timeout costs one chunk instead of the whole
// corpus. The FIRST chunk that stays unavailable after its attempts ends the pass: the embedder is
// taken as down, what was embedded so far is kept (the vectors below are a prefix of `bodies`, so
// positions still line up), and the rest waits for the next rebuild — which finds these vectors in
// the cache and only asks for the remainder. Nothing is asked for an empty list.
async function embedInChunks(embeddings: EmbeddingsClient, bodies: string[]): Promise<ChunkedEmbedding> {
  const chunks = chunksOf(bodies, REBUILD_EMBED_CHUNK_SIZE);
  const collected: Float32Array[] = [];
  let retries = 0;
  let chunksOkCount = 0;
  for (const chunk of chunks) {
    const result = await embeddings.embed(chunk, {
      timeoutMs: REBUILD_EMBED_TIMEOUT_MS,
      attempts: REBUILD_EMBED_ATTEMPTS,
    });
    retries += result.retries;
    if (!result.available) break;
    collected.push(...result.embeddings);
    chunksOkCount += 1;
  }
  return {
    embeddings: collected,
    available: chunksOkCount === chunks.length,
    retries,
    chunksCount: chunks.length,
    chunksOkCount,
  };
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
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
  model: string,
): number {
  // Runs INSIDE the caller's transaction — never opens one of its own.
  const insertVec = database.query("INSERT INTO vec(id, content_hash, embedding) VALUES (?, ?, ?)");
  let written = 0;
  for (const note of notes) {
    const hash = hashByBody.get(note.body)!;
    const bytes = bytesByHash.get(hash);
    if (bytes === undefined) continue;
    insertVec.run(note.frontmatter.id, hash, bytes);
    written += 1;
  }
  if (written > 0) database.run("INSERT INTO index_config(embedding_model) VALUES (?)", [model]);
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
  const database = openReadOnlyDatabase(indexPath);
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
  const database = openReadOnlyDatabase(indexPath);
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
  const database = openReadOnlyDatabase(indexPath);
  try {
    const rows = database
      .query("SELECT id, content_hash, hex(embedding) AS embedding FROM vec ORDER BY id")
      .all();
    return JSON.stringify(rows);
  } finally {
    database.close();
  }
}
