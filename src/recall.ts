import type { Database } from "bun:sqlite";
import type { EmbeddingsClient, EmbedResult } from "./embeddings";
import {
  cosineSimilarity,
  floatsFromBlob,
  RECALL_EMBED_ATTEMPTS,
  RECALL_EMBED_TIMEOUT_MS,
} from "./embeddings";
import type { EventWriter } from "./events";
import { DEFAULT_FUSION_PARAMS, compareIds, estimateTokens, fuseAndFill } from "./fusion";
import type { FusionDecision, FusionInput } from "./fusion";
import { RECALL_CANDIDATE_WINDOW, RECALL_MODES } from "./event-schema";

type RecallMode = (typeof RECALL_MODES)[number];

export interface RecallDeps {
  db: Database;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
  clock: () => Date;
}

// cosine is null in degraded mode or for a vector-less note; ftsRank is null when the note matched
// no query term. Both feed the recall-bundle threshold cut downstream.
export interface RecalledNote {
  id: string;
  body: string;
  cosine: number | null;
  ftsRank: number | null;
}

export interface RecallResult {
  returnedIds: string[];
  notes: RecalledNote[];
  degraded: boolean;
}

interface CosineRank {
  rank: number;
  cosine: number;
}

interface MetaRow {
  type: string;
  stalenessBoost: number;
}

interface RecallCandidate {
  id: string;
  type: string | null;
  fts_rank: number | null;
  vector_rank: number | null;
  cosine: number | null;
  rrf: number;
  staleness_boost: number;
  token_est: number | null;
  in_budget: boolean;
}

interface FusionOutcome {
  decisions: FusionDecision[];
  notes: RecalledNote[];
  cosineRanks: Map<string, CosineRank>;
  metaById: Map<string, MetaRow>;
  vectorAttempted: boolean;
  ms: number;
}

export async function recall(deps: RecallDeps, query: string, budget: number): Promise<RecallResult> {
  const terms = extractTerms(query);
  const embedded = await embedQuery(deps, query);
  const degraded = !(embedded.embed.available && hasStoredVectors(deps.db));
  const fts = rankFtsChannel(deps, terms);
  const fusion = runFusion(deps, fts.ranks, embedded.embed, budget);
  const returnedIds = fusion.notes.map((note) => note.id);
  deps.eventWriter.append({
    type: "recall",
    query,
    budget,
    returned_ids: returnedIds,
    degraded,
    mode: deriveMode(terms.length > 0, fusion.vectorAttempted),
    corpus_size: countMetaRows(deps.db),
    timings: { embed_ms: embedded.ms, fts_ms: fts.ms, fusion_ms: fusion.ms },
    candidates: buildCandidates(fusion.decisions, fts.ranks, fusion.cosineRanks, fusion.metaById),
  });
  return { returnedIds, notes: fusion.notes, degraded };
}

async function embedQuery(deps: RecallDeps, query: string): Promise<{ embed: EmbedResult; ms: number }> {
  const startedAt = deps.clock().getTime();
  const embed = await deps.embeddings.embed([query], {
    timeoutMs: RECALL_EMBED_TIMEOUT_MS,
    attempts: RECALL_EMBED_ATTEMPTS,
  });
  return { embed, ms: deps.clock().getTime() - startedAt };
}

function rankFtsChannel(deps: RecallDeps, terms: string[]): { ranks: Map<string, number>; ms: number } {
  // The cosine channel runs independently of FTS terms: a query with no lexical tokens the index can
  // match (e.g. a Cyrillic query against English notes) is still recalled semantically.
  if (terms.length === 0) return { ranks: new Map(), ms: 0 };
  const startedAt = deps.clock().getTime();
  const ranks = rankFts(deps.db, buildMatch(terms));
  return { ranks, ms: deps.clock().getTime() - startedAt };
}

// fusion_ms spans the dominant recall cost: the brute-force cosine scan, meta/body loading, the RRF
// fuse and the greedy budget fill.
function runFusion(
  deps: RecallDeps,
  ftsRanks: Map<string, number>,
  embed: EmbedResult,
  budget: number,
): FusionOutcome {
  const startedAt = deps.clock().getTime();
  const queryVector = embed.embeddings[0];
  const vectorAttempted = embed.available && queryVector !== undefined && hasSignal(queryVector);
  const cosineRanks =
    vectorAttempted && queryVector !== undefined
      ? rankCosine(deps.db, queryVector)
      : new Map<string, CosineRank>();
  const metaById = readMeta(deps.db);
  const bodyById = readBodies(deps.db);
  const decisions = fuseAndFill(
    assembleInputs(ftsRanks, cosineRanks, metaById, bodyById),
    DEFAULT_FUSION_PARAMS,
    budget,
  );
  const notes = collectNotes(decisions, bodyById, ftsRanks, cosineRanks);
  return { decisions, notes, cosineRanks, metaById, vectorAttempted, ms: deps.clock().getTime() - startedAt };
}

function assembleInputs(
  ftsRanks: Map<string, number>,
  cosineRanks: Map<string, CosineRank>,
  metaById: Map<string, MetaRow>,
  bodyById: Map<string, string>,
): FusionInput[] {
  const candidateIds = new Set([...ftsRanks.keys(), ...cosineRanks.keys()]);
  return [...candidateIds].map((id) => {
    const body = bodyById.get(id);
    return {
      id,
      ftsRank: ftsRanks.get(id) ?? null,
      vectorRank: cosineRanks.get(id)?.rank ?? null,
      stalenessBoost: metaById.get(id)?.stalenessBoost ?? 0,
      tokenEst: body === undefined ? null : estimateTokens(body),
    };
  });
}

// An in-budget decision was admitted by the fill, which requires a non-null token estimate, which in
// turn required the note's body row — so the body lookup here cannot miss.
function collectNotes(
  decisions: FusionDecision[],
  bodyById: Map<string, string>,
  ftsRanks: Map<string, number>,
  cosineRanks: Map<string, CosineRank>,
): RecalledNote[] {
  return decisions
    .filter((decision) => decision.inBudget)
    .map((decision) => ({
      id: decision.id,
      body: bodyById.get(decision.id)!,
      cosine: cosineRanks.get(decision.id)?.cosine ?? null,
      ftsRank: ftsRanks.get(decision.id) ?? null,
    }));
}

function buildCandidates(
  decisions: FusionDecision[],
  ftsRanks: Map<string, number>,
  cosineRanks: Map<string, CosineRank>,
  metaById: Map<string, MetaRow>,
): RecallCandidate[] {
  return decisions.slice(0, RECALL_CANDIDATE_WINDOW).map((decision) => ({
    id: decision.id,
    type: metaById.get(decision.id)?.type ?? null,
    fts_rank: ftsRanks.get(decision.id) ?? null,
    vector_rank: cosineRanks.get(decision.id)?.rank ?? null,
    cosine: cosineRanks.get(decision.id)?.cosine ?? null,
    rrf: decision.rrf,
    staleness_boost: metaById.get(decision.id)?.stalenessBoost ?? 0,
    token_est: decision.tokenEst,
    in_budget: decision.inBudget,
  }));
}

function deriveMode(ftsAttempted: boolean, vectorAttempted: boolean): RecallMode {
  if (ftsAttempted && vectorAttempted) return "fused";
  if (ftsAttempted) return "fts_only";
  if (vectorAttempted) return "vector_only";
  return "none";
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

function countMetaRows(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM meta").get() as { count: number };
  return row.count;
}

function rankFts(db: Database, match: string): Map<string, number> {
  const rows = db.query("SELECT id FROM fts WHERE fts MATCH ? ORDER BY rank, id").all(match) as Array<{
    id: string;
  }>;
  return new Map(rows.map((row, index) => [row.id, index + 1]));
}

function rankCosine(db: Database, queryVector: Float32Array): Map<string, CosineRank> {
  const rows = db.query("SELECT id, embedding FROM vec").all() as Array<{
    id: string;
    embedding: Uint8Array;
  }>;
  const scored: Array<{ id: string; cosine: number }> = [];
  for (const row of rows) {
    const vector = floatsFromBlob(row.embedding);
    if (vector === undefined) continue;
    scored.push({ id: row.id, cosine: cosineSimilarity(queryVector, vector) });
  }
  scored.sort((left, right) => right.cosine - left.cosine || compareIds(left.id, right.id));
  return new Map(scored.map((row, index) => [row.id, { rank: index + 1, cosine: row.cosine }]));
}

function readMeta(db: Database): Map<string, MetaRow> {
  const rows = db.query("SELECT id, type, staleness_boost FROM meta").all() as Array<{
    id: string;
    type: string;
    staleness_boost: number;
  }>;
  return new Map(rows.map((row) => [row.id, { type: row.type, stalenessBoost: row.staleness_boost }]));
}

function readBodies(db: Database): Map<string, string> {
  const rows = db.query("SELECT id, body FROM fts").all() as Array<{ id: string; body: string }>;
  return new Map(rows.map((row) => [row.id, row.body]));
}
