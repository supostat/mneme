import type { EmbeddingsClient } from "./embeddings";
import { nearestNeighbor } from "./index-db";

export const DEDUP_SUPERSEDE_THRESHOLD = 0.85;
export const DEDUP_NOOP_THRESHOLD = 0.97;

// Thresholds arrive as a required argument (config.dedup at runtime): the compiler forces every
// caller to name where its thresholds come from, so a configured override cannot be silently
// bypassed by a call site that still reads the module constants.
export interface DedupThresholds {
  supersedeThreshold: number;
  noopThreshold: number;
}

export type DedupClassification =
  | { kind: "add"; degraded: boolean; neighborId: string | null; similarity: number | null }
  | { kind: "supersede_offer"; neighborId: string; similarity: number }
  | { kind: "noop"; neighborId: string; similarity: number };

export async function classifyCandidate(
  indexPath: string,
  embeddings: EmbeddingsClient,
  body: string,
  thresholds: DedupThresholds,
): Promise<DedupClassification> {
  const embedded = await embeddings.embed([body]);
  const queryVector = embedded.available ? embedded.embeddings[0] : undefined;
  if (queryVector === undefined) {
    return { kind: "add", degraded: true, neighborId: null, similarity: null };
  }
  const neighbor = nearestNeighbor(indexPath, queryVector);
  if (neighbor === undefined) {
    return { kind: "add", degraded: false, neighborId: null, similarity: null };
  }
  if (neighbor.similarity >= thresholds.noopThreshold) {
    return { kind: "noop", neighborId: neighbor.id, similarity: neighbor.similarity };
  }
  if (neighbor.similarity >= thresholds.supersedeThreshold) {
    return { kind: "supersede_offer", neighborId: neighbor.id, similarity: neighbor.similarity };
  }
  return { kind: "add", degraded: false, neighborId: neighbor.id, similarity: neighbor.similarity };
}
