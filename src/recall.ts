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
import type { RecallOrigin } from "./event-schema";
import { MAP_SECTION_KINDS, isMapSectionId } from "./map/map-section";
import type { MapSectionKind } from "./map/map-section";

type RecallMode = (typeof RECALL_MODES)[number];

export interface RecallDeps {
  db: Database;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
  clock: () => Date;
}

// cosine is null in degraded mode or for a vector-less note; ftsRank is null when the note matched
// no query term. Both feed passesRecallThreshold, which drops the cosine-only tail below threshold.
// lowConfidence is true only for a note surfaced by the cold-start floor — every survivor was below
// the cosine threshold, so the corpus is too poor to trust — and false for a threshold-passing note.
export interface RecalledNote {
  id: string;
  body: string;
  cosine: number | null;
  ftsRank: number | null;
  lowConfidence: boolean;
}

// A map section the query reached: ranked by its own channel pair, cut by the same threshold as a
// note. A domain carries the ids of the notes linked to it (the rebuild's anchor containment: a
// note anchor equal to or below a domain anchor); a flow carries none — its context is the domains
// it names, not a note population.
export interface RecalledSection {
  id: string;
  kind: MapSectionKind;
  body: string;
  cosine: number | null;
  ftsRank: number | null;
  noteIds: string[];
}

export interface RecallResult {
  returnedIds: string[];
  notes: RecalledNote[];
  sections: RecalledSection[];
  degraded: boolean;
  // True when neither a note nor a section passed the relevance threshold: the memory gap the
  // notice reports and the stats metric counts. The cold-start floor's low-confidence notes leave
  // it true — they are shown, but they are not memory above the threshold.
  gap: boolean;
}

// A domain filter names a domain the map does not hold — or a string that is not even a section
// slug. Fail-closed: an unknown domain is an error, never a silently empty answer.
export class RecallDomainError extends Error {}

interface CosineRank {
  rank: number;
  cosine: number;
}

interface MetaRow {
  type: string;
  stalenessBoost: number;
}

interface SectionMetaRow {
  kind: MapSectionKind;
  stalenessBoost: number;
}

// The populations a domain filter leaves in play; null means the whole population. The filter is
// applied BEFORE ranking in both channels, so ranks are dense over the survivors and the logged
// candidates already reflect it — replay reproduces a filtered recall as it was.
interface RecallScope {
  noteIds: Set<string> | null;
  sectionIds: Set<string> | null;
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

interface SectionCandidate {
  id: string;
  kind: MapSectionKind;
  fts_rank: number | null;
  vector_rank: number | null;
  cosine: number | null;
  returned: boolean;
}

interface FusionOutcome {
  decisions: FusionDecision[];
  notes: RecalledNote[];
  cosineRanks: Map<string, CosineRank>;
  metaById: Map<string, MetaRow>;
  vectorAttempted: boolean;
  ms: number;
}

interface SectionOutcome {
  returned: RecalledSection[];
  candidates: SectionCandidate[];
  ms: number;
}

// The absolute cosine floor for keeping a cosine-only note, owned here by the recall scorer. FTS
// survivors are lexically gated and bypass it, so it cuts only the semantic Lost-in-Noise tail, never
// a top-N. The workflow bundle (memory-steps) imports this value rather than redeclaring it.
export const RECALL_BUNDLE_COSINE_THRESHOLD = 0.35;

// Cold-start protection: when the threshold empties an otherwise non-empty result — a poor corpus of
// only sub-threshold cosine hits — recall returns this many top-ranked notes marked low-confidence
// instead of nothing, so recall is never empty while notes exist.
export const RECALL_LOW_CONFIDENCE_FLOOR = 3;

// At most this many map sections ride one recall. Sections are not charged to the notes budget:
// their volume is bounded by this cap and the section body limit, so a long section can never
// crowd the notes out, and the cap keeps two sections from becoming a wall of context.
export const RECALL_MAP_SECTIONS_MAX = 2;

// The last line of an answer whose every note and section fell below the threshold. It says in so
// many words that memory holds nothing for this question, so the honest move is to record what is
// learned — silence must never read as "nothing to know". Owned here, beside the threshold it
// reports on; the renderers print it, the workflow bundle included.
export const RECALL_GAP_NOTICE =
  "No memory above the relevance threshold for this question: record what you learn with remember.";

// A note or a section survives recall iff it matched a query term (FTS, already lexically gated) or
// cleared the absolute cosine floor. Shared with memory-steps so the live path and the workflow
// bundle cut alike, and shared by both populations so a section is never admitted more cheaply
// than a note.
export function passesRecallThreshold(candidate: { ftsRank: number | null; cosine: number | null }): boolean {
  return candidate.ftsRank !== null || (candidate.cosine !== null && candidate.cosine >= RECALL_BUNDLE_COSINE_THRESHOLD);
}

export async function recall(
  deps: RecallDeps,
  query: string,
  budget: number,
  origin: RecallOrigin,
  domains: string[],
): Promise<RecallResult> {
  const scope = resolveScope(deps.db, domains);
  const terms = extractTerms(query);
  const embedded = await embedQuery(deps, query);
  const degraded = !(embedded.embed.available && hasStoredVectors(deps.db));
  const fts = rankFtsChannel(deps, terms, scope.noteIds);
  const fusion = runFusion(deps, fts.ranks, embedded.embed, budget, scope.noteIds);
  const sections = rankSections(deps, terms, embedded.embed, scope.sectionIds);
  const gap = isMemoryGap(fusion.notes, sections.returned);
  const returnedIds = fusion.notes.map((note) => note.id);
  deps.eventWriter.append({
    type: "recall",
    query,
    budget,
    returned_ids: returnedIds,
    degraded,
    origin,
    mode: deriveMode(terms.length > 0, fusion.vectorAttempted),
    corpus_size: countMetaRows(deps.db),
    timings: { embed_ms: embedded.ms, fts_ms: fts.ms, fusion_ms: fusion.ms + sections.ms },
    candidates: buildCandidates(fusion.decisions, fts.ranks, fusion.cosineRanks, fusion.metaById),
    domains,
    sections: sections.candidates,
    gap,
  });
  return { returnedIds, notes: fusion.notes, sections: sections.returned, degraded, gap };
}

// Decided on what recall RETURNS, after the cut: a floor note is below the threshold by
// construction and never closes a gap, while one section above it closes the gap alone.
function isMemoryGap(notes: RecalledNote[], sections: RecalledSection[]): boolean {
  return !notes.some(passesRecallThreshold) && sections.length === 0;
}

async function embedQuery(deps: RecallDeps, query: string): Promise<{ embed: EmbedResult; ms: number }> {
  const startedAt = deps.clock().getTime();
  const embed = await deps.embeddings.embed([query], {
    timeoutMs: RECALL_EMBED_TIMEOUT_MS,
    attempts: RECALL_EMBED_ATTEMPTS,
  });
  return { embed, ms: deps.clock().getTime() - startedAt };
}

// Every listed domain must exist as a domain; the note universe is the union of their links and
// the section universe is the domains themselves plus the flows that name one of them.
function resolveScope(db: Database, domains: string[]): RecallScope {
  if (domains.length === 0) return { noteIds: null, sectionIds: null };
  const domainIds = [...new Set(domains)];
  for (const id of domainIds) requireDomain(db, id);
  const noteIds = new Set<string>();
  const sectionIds = new Set(domainIds);
  const linkedNotes = db.query("SELECT note_id FROM map_links WHERE section_id = ?");
  const dependentFlows = db.query(
    "SELECT map_deps.section_id AS id FROM map_deps JOIN map_meta ON map_meta.id = map_deps.section_id" +
      " WHERE map_deps.depends_on = ? AND map_meta.kind = 'flow'",
  );
  for (const id of domainIds) {
    for (const row of linkedNotes.all(id) as Array<{ note_id: string }>) noteIds.add(row.note_id);
    for (const row of dependentFlows.all(id) as Array<{ id: string }>) sectionIds.add(requireSectionId(row.id));
  }
  return { noteIds, sectionIds };
}

function requireDomain(db: Database, id: string): void {
  const message = `no map domain ${JSON.stringify(id)}`;
  if (!isMapSectionId(id)) throw new RecallDomainError(message);
  const row = db.query("SELECT kind FROM map_meta WHERE id = ?").get(id) as { kind: string } | null;
  if (row === null || row.kind !== "domain") throw new RecallDomainError(message);
}

function rankFtsChannel(
  deps: RecallDeps,
  terms: string[],
  scope: Set<string> | null,
): { ranks: Map<string, number>; ms: number } {
  // The cosine channel runs independently of FTS terms: a query with no lexical tokens the index can
  // match (e.g. a Cyrillic query against English notes) is still recalled semantically.
  if (terms.length === 0) return { ranks: new Map(), ms: 0 };
  const startedAt = deps.clock().getTime();
  const ranks = rankFts(deps.db, "fts", buildMatch(terms), scope);
  return { ranks, ms: deps.clock().getTime() - startedAt };
}

// fusion_ms spans the dominant recall cost: the brute-force cosine scan, meta/body loading, the RRF
// fuse and the greedy budget fill.
function runFusion(
  deps: RecallDeps,
  ftsRanks: Map<string, number>,
  embed: EmbedResult,
  budget: number,
  scope: Set<string> | null,
): FusionOutcome {
  const startedAt = deps.clock().getTime();
  const queryVector = signalVector(embed);
  const vectorAttempted = queryVector !== undefined;
  const cosineRanks = queryVector === undefined ? new Map<string, CosineRank>() : rankCosine(deps.db, "vec", queryVector, scope);
  const metaById = readMeta(deps.db);
  const bodyById = readBodies(deps.db, "fts");
  const decisions = fuseAndFill(
    assembleInputs(ftsRanks, cosineRanks, metaById, bodyById),
    DEFAULT_FUSION_PARAMS,
    budget,
  );
  const notes = applyRecallThreshold(collectNotes(decisions, bodyById, ftsRanks, cosineRanks));
  return { decisions, notes, cosineRanks, metaById, vectorAttempted, ms: deps.clock().getTime() - startedAt };
}

function assembleInputs(
  ftsRanks: Map<string, number>,
  cosineRanks: Map<string, CosineRank>,
  metaById: Map<string, { stalenessBoost: number }>,
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
      lowConfidence: false,
    }));
}

// The cut runs on the budget-filled set, leaving the logged pre-threshold candidate vector (and thus
// offline replay) untouched. When the cut would empty an otherwise non-empty result — a cold corpus of
// only sub-threshold cosine hits — the top-ranked notes return marked low-confidence instead.
function applyRecallThreshold(budgetFilled: RecalledNote[]): RecalledNote[] {
  const passing = budgetFilled.filter(passesRecallThreshold);
  if (passing.length > 0) return passing;
  return budgetFilled
    .slice(0, RECALL_LOW_CONFIDENCE_FLOOR)
    .map((note) => ({ ...note, lowConfidence: true }));
}

// The section channel: the same two rankings over the map tables, the same RRF, no token budget (the
// fill runs unbounded) and the same threshold; the first RECALL_MAP_SECTIONS_MAX survivors in fused
// order return. Every id read from the map tables is re-validated against the section-id grammar
// before it names anything — the index is a writable cache, not an authenticated source.
function rankSections(
  deps: RecallDeps,
  terms: string[],
  embed: EmbedResult,
  scope: Set<string> | null,
): SectionOutcome {
  const startedAt = deps.clock().getTime();
  const metaById = readSectionMeta(deps.db);
  const ftsRanks = terms.length === 0 ? new Map<string, number>() : rankFts(deps.db, "map_fts", buildMatch(terms), scope);
  const queryVector = signalVector(embed);
  const cosineRanks = queryVector === undefined ? new Map<string, CosineRank>() : rankCosine(deps.db, "map_vec", queryVector, scope);
  const bodyById = readBodies(deps.db, "map_fts");
  const decisions = fuseAndFill(
    assembleInputs(ftsRanks, cosineRanks, metaById, bodyById),
    DEFAULT_FUSION_PARAMS,
    Number.POSITIVE_INFINITY,
  );
  const returned: RecalledSection[] = [];
  for (const decision of decisions) {
    if (returned.length >= RECALL_MAP_SECTIONS_MAX) break;
    const candidate = { ftsRank: ftsRanks.get(decision.id) ?? null, cosine: cosineRanks.get(decision.id)?.cosine ?? null };
    if (!passesRecallThreshold(candidate)) continue;
    const kind = metaById.get(decision.id)!.kind;
    returned.push({
      id: decision.id,
      kind,
      body: bodyById.get(decision.id)!,
      cosine: candidate.cosine,
      ftsRank: candidate.ftsRank,
      noteIds: kind === "domain" ? linkedNoteIds(deps.db, decision.id) : [],
    });
  }
  const returnedIds = new Set(returned.map((section) => section.id));
  const candidates = decisions.slice(0, RECALL_CANDIDATE_WINDOW).map((decision) => ({
    id: decision.id,
    kind: metaById.get(decision.id)!.kind,
    fts_rank: ftsRanks.get(decision.id) ?? null,
    vector_rank: cosineRanks.get(decision.id)?.rank ?? null,
    cosine: cosineRanks.get(decision.id)?.cosine ?? null,
    returned: returnedIds.has(decision.id),
  }));
  return { returned, candidates, ms: deps.clock().getTime() - startedAt };
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

// The query vector when the embedder answered with one that carries signal. A zero-norm vector
// carries no semantic signal — cosine against it is undefined for every note — so it is excluded
// from the cosine channel exactly as an empty term list excludes FTS.
function signalVector(embed: EmbedResult): Float32Array | undefined {
  const vector = embed.embeddings[0];
  if (!embed.available || vector === undefined || !hasSignal(vector)) return undefined;
  return vector;
}

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

type FtsTable = "fts" | "map_fts";
type VectorTable = "vec" | "map_vec";

// Ranks are dense over the scope: rows outside it are dropped before numbering, so a filtered
// recall ranks exactly as a corpus holding only those rows would.
function rankFts(db: Database, table: FtsTable, match: string, scope: Set<string> | null): Map<string, number> {
  const rows = db.query(`SELECT id FROM ${table} WHERE ${table} MATCH ? ORDER BY rank, id`).all(match) as Array<{
    id: string;
  }>;
  const inScope = rows.filter((row) => scope === null || scope.has(row.id));
  return new Map(inScope.map((row, index) => [row.id, index + 1]));
}

function rankCosine(
  db: Database,
  table: VectorTable,
  queryVector: Float32Array,
  scope: Set<string> | null,
): Map<string, CosineRank> {
  const rows = db.query(`SELECT id, embedding FROM ${table}`).all() as Array<{
    id: string;
    embedding: Uint8Array;
  }>;
  const scored: Array<{ id: string; cosine: number }> = [];
  for (const row of rows) {
    if (scope !== null && !scope.has(row.id)) continue;
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

function readSectionMeta(db: Database): Map<string, SectionMetaRow> {
  const rows = db.query("SELECT id, kind, staleness_boost FROM map_meta").all() as Array<{
    id: string;
    kind: string;
    staleness_boost: number;
  }>;
  return new Map(
    rows.map((row) => [requireSectionId(row.id), { kind: requireSectionKind(row.kind), stalenessBoost: row.staleness_boost }]),
  );
}

function readBodies(db: Database, table: FtsTable): Map<string, string> {
  const rows = db.query(`SELECT id, body FROM ${table}`).all() as Array<{ id: string; body: string }>;
  return new Map(rows.map((row) => [row.id, row.body]));
}

function linkedNoteIds(db: Database, sectionId: string): string[] {
  const rows = db.query("SELECT note_id FROM map_links WHERE section_id = ? ORDER BY note_id").all(sectionId) as Array<{
    note_id: string;
  }>;
  return rows.map((row) => row.note_id);
}

function requireSectionId(id: string): string {
  if (!isMapSectionId(id)) {
    throw new Error(`the index returned a malformed map section id: ${JSON.stringify(id)}`);
  }
  return id;
}

function requireSectionKind(kind: string): MapSectionKind {
  if (!(MAP_SECTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`the index returned an unknown map section kind: ${JSON.stringify(kind)}`);
  }
  return kind as MapSectionKind;
}
