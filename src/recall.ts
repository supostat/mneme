import type { Database } from "bun:sqlite";
import type { EmbeddingsClient } from "./embeddings";
import { EMBEDDING_DIMENSION, RECALL_EMBED_ATTEMPTS, RECALL_EMBED_TIMEOUT_MS } from "./embeddings";
import type { EventWriter } from "./events";

const RRF_K = 60;
const TOKEN_BYTES = 4;
const FLOAT_BYTES = 4;
const EMBEDDING_BLOB_BYTES = EMBEDDING_DIMENSION * FLOAT_BYTES;

export interface RecallDeps {
  db: Database;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
}

export interface RecallResult {
  returnedIds: string[];
  degraded: boolean;
}

interface ScoredNote {
  id: string;
  score: number;
}

export async function recall(deps: RecallDeps, query: string, budget: number): Promise<RecallResult> {
  const terms = extractTerms(query);
  const embed = await deps.embeddings.embed([query], {
    timeoutMs: RECALL_EMBED_TIMEOUT_MS,
    attempts: RECALL_EMBED_ATTEMPTS,
  });
  // D8: without stored vectors cosine fusion cannot run, so an available embedder alone is not enough.
  const degraded = !(embed.available && hasStoredVectors(deps.db));
  let returnedIds: string[] = [];
  if (terms.length > 0) {
    const ftsRanks = rankFts(deps.db, buildMatch(terms));
    const queryVector = embed.embeddings[0];
    const cosineRanks =
      embed.available && queryVector !== undefined
        ? rankCosine(deps.db, queryVector)
        : new Map<string, number>();
    const fused = fuse(deps.db, ftsRanks, cosineRanks);
    returnedIds = greedyFill(deps.db, fused, budget);
  }
  deps.eventWriter.append({ type: "recall", query, budget, returned_ids: returnedIds, degraded });
  return { returnedIds, degraded };
}

function extractTerms(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function buildMatch(terms: string[]): string {
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

function hasStoredVectors(db: Database): boolean {
  const row = db.query("SELECT COUNT(*) AS count FROM vec").get() as { count: number };
  return row.count > 0;
}

function rankFts(db: Database, match: string): Map<string, number> {
  const rows = db.query("SELECT id FROM fts WHERE fts MATCH ? ORDER BY rank, id").all(match) as Array<{
    id: string;
  }>;
  return new Map(rows.map((row, index) => [row.id, index + 1]));
}

function rankCosine(db: Database, queryVector: Float32Array): Map<string, number> {
  const rows = db.query("SELECT id, embedding FROM vec").all() as Array<{
    id: string;
    embedding: Uint8Array;
  }>;
  const scored: ScoredNote[] = [];
  for (const row of rows) {
    const vector = floatsFromBlob(row.embedding);
    if (vector === undefined) continue;
    scored.push({ id: row.id, score: cosineSimilarity(queryVector, vector) });
  }
  scored.sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  return new Map(scored.map((row, index) => [row.id, index + 1]));
}

function fuse(
  db: Database,
  ftsRanks: Map<string, number>,
  cosineRanks: Map<string, number>,
): ScoredNote[] {
  const stalenessById = readStaleness(db);
  const candidateIds = new Set([...ftsRanks.keys(), ...cosineRanks.keys()]);
  const scored = [...candidateIds].map((id) => ({
    id,
    score:
      contribution(ftsRanks, id) +
      contribution(cosineRanks, id) +
      (stalenessById.get(id) ?? 0),
  }));
  scored.sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  return scored;
}

function contribution(ranks: Map<string, number>, id: string): number {
  const rank = ranks.get(id);
  return rank === undefined ? 0 : 1 / (RRF_K + rank);
}

function readStaleness(db: Database): Map<string, number> {
  const rows = db.query("SELECT id, staleness_boost FROM meta").all() as Array<{
    id: string;
    staleness_boost: number;
  }>;
  return new Map(rows.map((row) => [row.id, row.staleness_boost]));
}

function greedyFill(db: Database, fused: ScoredNote[], budget: number): string[] {
  const bodyById = new Map(
    (db.query("SELECT id, body FROM fts").all() as Array<{ id: string; body: string }>).map(
      (row) => [row.id, row.body],
    ),
  );
  const included: string[] = [];
  let used = 0;
  for (const { id } of fused) {
    const body = bodyById.get(id);
    if (body === undefined) continue;
    const estimate = Math.ceil(Buffer.byteLength(body, "utf8") / TOKEN_BYTES);
    if (used + estimate <= budget) {
      included.push(id);
      used += estimate;
    }
  }
  return included;
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

function floatsFromBlob(blob: Uint8Array): Float32Array | undefined {
  if (blob.byteLength !== EMBEDDING_BLOB_BYTES) return undefined;
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / FLOAT_BYTES);
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
