// The pure RRF-with-budget decision core shared by the live recall path (src/recall.ts) and the
// offline replay tool (scripts/replay.ts). Both derive the ranked, budget-filled decision vector by
// calling fuseAndFill, so there is exactly one fusion implementation and no drift between what recall
// logs and what replay recomputes. With DEFAULT_FUSION_PARAMS the arithmetic is bit-identical to the
// original inline fusion: multiplying a contribution by weight 1 is an IEEE-754 no-op, and the
// left-associative addition order (ftsContribution + vectorContribution) + stalenessBoost is
// preserved, so the historical recall determinism is unchanged.

export const RRF_K = 60;
export const TOKEN_BYTES = 4;

export interface FusionInput {
  id: string;
  ftsRank: number | null;
  vectorRank: number | null;
  stalenessBoost: number;
  tokenEst: number | null;
}

export interface FusionParams {
  rrfK: number;
  ftsWeight: number;
  vectorWeight: number;
  stalenessWeight: number;
}

export const DEFAULT_FUSION_PARAMS: FusionParams = {
  rrfK: RRF_K,
  ftsWeight: 1,
  vectorWeight: 1,
  stalenessWeight: 1,
};

export interface FusionDecision {
  id: string;
  rrf: number;
  score: number;
  tokenEst: number | null;
  inBudget: boolean;
}

interface ScoredEntry {
  id: string;
  rrf: number;
  score: number;
  tokenEst: number | null;
}

export function fuseAndFill(
  inputs: FusionInput[],
  params: FusionParams,
  budget: number,
): FusionDecision[] {
  const scored = inputs.map((input) => scoredEntry(input, params));
  scored.sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  return fill(scored, budget);
}

function scoredEntry(input: FusionInput, params: FusionParams): ScoredEntry {
  const rrf =
    params.ftsWeight * contribution(params.rrfK, input.ftsRank) +
    params.vectorWeight * contribution(params.rrfK, input.vectorRank);
  const score = rrf + params.stalenessWeight * input.stalenessBoost;
  return { id: input.id, rrf, score, tokenEst: input.tokenEst };
}

function contribution(rrfK: number, rank: number | null): number {
  return rank === null ? 0 : 1 / (rrfK + rank);
}

// Greedy fill in ranked order: a note is included when its byte-derived estimate still fits the
// remaining budget. A note that does not fit (or has no body to estimate) is skipped WITHOUT halting,
// so a smaller lower-ranked note can still be admitted after a larger one was passed over.
function fill(scored: ScoredEntry[], budget: number): FusionDecision[] {
  const decisions: FusionDecision[] = [];
  let used = 0;
  for (const entry of scored) {
    let inBudget = false;
    if (entry.tokenEst !== null && used + entry.tokenEst <= budget) {
      inBudget = true;
      used += entry.tokenEst;
    }
    decisions.push({ id: entry.id, rrf: entry.rrf, score: entry.score, tokenEst: entry.tokenEst, inBudget });
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
