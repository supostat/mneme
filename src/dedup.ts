import type { EmbeddingsClient } from "./embeddings";
import { nearestNeighbor } from "./index-db";

export const DEDUP_SUPERSEDE_THRESHOLD = 0.85;
export const DEDUP_NOOP_THRESHOLD = 0.97;

export type DedupClassification =
  | { kind: "add"; degraded: boolean; neighborId: string | null; similarity: number | null }
  | { kind: "supersede_offer"; neighborId: string; similarity: number }
  | { kind: "noop"; neighborId: string; similarity: number };

export async function classifyCandidate(
  indexPath: string,
  embeddings: EmbeddingsClient,
  body: string,
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
  if (neighbor.similarity >= DEDUP_NOOP_THRESHOLD) {
    return { kind: "noop", neighborId: neighbor.id, similarity: neighbor.similarity };
  }
  if (neighbor.similarity >= DEDUP_SUPERSEDE_THRESHOLD) {
    return { kind: "supersede_offer", neighborId: neighbor.id, similarity: neighbor.similarity };
  }
  return { kind: "add", degraded: false, neighborId: neighbor.id, similarity: neighbor.similarity };
}
