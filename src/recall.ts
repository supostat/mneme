import type { Database } from "bun:sqlite";
import type { EmbeddingsClient } from "./embeddings";
import {
  cosineSimilarity,
  floatsFromBlob,
  RECALL_EMBED_ATTEMPTS,
  RECALL_EMBED_TIMEOUT_MS,
} from "./embeddings";
import type { EventWriter } from "./events";

const RRF_K = 60;
const TOKEN_BYTES = 4;

export interface RecallDeps {
  db: Database;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
}

export interface RecalledNote {
  id: string;
  body: string;
}

export interface RecallResult {
  returnedIds: string[];
  notes: RecalledNote[];
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
  // The cosine channel runs independently of FTS terms: a query with no lexical tokens the index
  // can match (e.g. a Cyrillic query against English notes) is still recalled semantically.
  const ftsRanks =
    terms.length > 0 ? rankFts(deps.db, buildMatch(terms)) : new Map<string, number>();
  const queryVector = embed.embeddings[0];
  const cosineRanks =
    embed.available && queryVector !== undefined && hasSignal(queryVector)
      ? rankCosine(deps.db, queryVector)
      : new Map<string, number>();
  const fused = fuse(deps.db, ftsRanks, cosineRanks);
  const notes = greedyFill(deps.db, fused, budget);
  const returnedIds = notes.map((note) => note.id);
  deps.eventWriter.append({ type: "recall", query, budget, returned_ids: returnedIds, degraded });
  return { returnedIds, notes, degraded };
}

function extractTerms(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// A zero-norm query vector carries no semantic signal — cosine against it is undefined for every
// note, so it is excluded from the cosine channel exactly as an empty term list excludes FTS.
function hasSignal(vector: Float32Array): boolean {
  for (let index = 0; index < vector.length; index++) {
    if (vector[index] !== 0) return true;
  }
  return false;
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

function greedyFill(db: Database, fused: ScoredNote[], budget: number): RecalledNote[] {
  const bodyById = new Map(
    (db.query("SELECT id, body FROM fts").all() as Array<{ id: string; body: string }>).map(
      (row) => [row.id, row.body],
    ),
  );
  const included: RecalledNote[] = [];
  let used = 0;
  for (const { id } of fused) {
    const body = bodyById.get(id);
    if (body === undefined) continue;
    const estimate = Math.ceil(Buffer.byteLength(body, "utf8") / TOKEN_BYTES);
    if (used + estimate <= budget) {
      included.push({ id, body });
      used += estimate;
    }
  }
  return included;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
