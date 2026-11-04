// The pure ranking-and-budget decision core shared by the live recall path (src/recall.ts) and the
// offline replay tool (scripts/replay.ts). Both derive the ranked, budget-filled decision vector by
// calling fuseAndFill, so there is exactly one fusion implementation and no drift between what recall
// logs and what replay recomputes.
//
// The order is lexicographic over four keys, never a weighted sum: the anchor class first (a live
// candidate before a dead-anchored one), then the RRF sum descending, then the staleness boost
// descending (less drift first), then the id ascending. Drift therefore orders only candidates of
// EQUAL relevance — an exact tie of the RRF float — and can never lift a less relevant candidate
// above a more relevant one. The logged rrf and staleness_boost ARE the two middle keys, so replay
// reproduces the order from the log alone.

export const RRF_K = 60;
export const TOKEN_BYTES = 4;
// The recall budget in tokens a project runs on until its config says otherwise. It lives here,
// with the token arithmetic it is measured in, because this module imports nothing: every
// consumer — config, recall, the map section limit — can take it without forming an import cycle.
export const DEFAULT_RECALL_BUDGET = 2000;
// The staleness boost of an anchor that is gone, or whose commit base git cannot count from. It is
// the comparator's class boundary — a candidate at or below it ranks under every live one whatever
// its relevance — so it is declared beside the comparator in this import-free module;
// src/staleness.ts re-exports it for the liveness code and its callers.
export const DEAD_ANCHOR_SINK = -1;

export interface FusionInput {
  id: string;
  ftsRank: number | null;
  vectorRank: number | null;
  stalenessBoost: number;
  tokenEst: number | null;
}

// The knobs of replay's alternative-parameter mode. Staleness has no weight: it is a sort key, and
// a key is either consulted or not — scaling it would change nothing.
export interface FusionParams {
  rrfK: number;
  ftsWeight: number;
  vectorWeight: number;
}

export const DEFAULT_FUSION_PARAMS: FusionParams = {
  rrfK: RRF_K,
  ftsWeight: 1,
  vectorWeight: 1,
};

export interface FusionDecision {
  id: string;
  rrf: number;
  tokenEst: number | null;
  inBudget: boolean;
}

interface RankedEntry {
  id: string;
  rrf: number;
  stalenessBoost: number;
  tokenEst: number | null;
}

export function fuseAndFill(
  inputs: FusionInput[],
  params: FusionParams,
  budget: number,
): FusionDecision[] {
  const ranked = inputs.map((input) => rankedEntry(input, params));
  ranked.sort(compareRanked);
  return fill(ranked, budget);
}

function rankedEntry(input: FusionInput, params: FusionParams): RankedEntry {
  const rrf =
    params.ftsWeight * contribution(params.rrfK, input.ftsRank) +
    params.vectorWeight * contribution(params.rrfK, input.vectorRank);
  return { id: input.id, rrf, stalenessBoost: input.stalenessBoost, tokenEst: input.tokenEst };
}

// Live before dead, then the more relevant first, then the less drifted first, then the smaller id.
function compareRanked(left: RankedEntry, right: RankedEntry): number {
  return (
    deadClass(left) - deadClass(right) ||
    right.rrf - left.rrf ||
    right.stalenessBoost - left.stalenessBoost ||
    compareIds(left.id, right.id)
  );
}

function deadClass(entry: RankedEntry): number {
  return entry.stalenessBoost <= DEAD_ANCHOR_SINK ? 1 : 0;
}

function contribution(rrfK: number, rank: number | null): number {
  return rank === null ? 0 : 1 / (rrfK + rank);
}

// Greedy fill in ranked order: a note is included when its byte-derived estimate still fits the
// remaining budget. A note that does not fit (or has no body to estimate) is skipped WITHOUT halting,
// so a smaller lower-ranked note can still be admitted after a larger one was passed over.
function fill(ranked: RankedEntry[], budget: number): FusionDecision[] {
  const decisions: FusionDecision[] = [];
  let used = 0;
  for (const entry of ranked) {
    let inBudget = false;
    if (entry.tokenEst !== null && used + entry.tokenEst <= budget) {
      inBudget = true;
      used += entry.tokenEst;
    }
    decisions.push({ id: entry.id, rrf: entry.rrf, tokenEst: entry.tokenEst, inBudget });
  }
  return decisions;
}

export function estimateTokens(body: string): number {
  return Math.ceil(Buffer.byteLength(body, "utf8") / TOKEN_BYTES);
}

export function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
