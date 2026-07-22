import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "./corpus";
import type { DedupClassification, DedupThresholds } from "./dedup";

const SIDECAR_EXTENSION = ".dedup.json";

export type StagedClassification = Exclude<DedupClassification, { kind: "noop" }>;

export interface Sidecar {
  dedup: "add" | "supersede_offer";
  nearest_id: string | null;
  similarity: number | null;
  degraded: boolean;
  supersede_threshold: number;
  noop_threshold: number;
}

export type DedupSummary =
  | { kind: "unavailable" }
  | { kind: "no_neighbor" }
  | { kind: "neighbor"; nearestId: string; similarity: number };

function sidecarPath(corpus: Corpus, id: string): string {
  return join(corpus.stagingDir, `${id}${SIDECAR_EXTENSION}`);
}

export function sidecarFor(classification: StagedClassification, thresholds: DedupThresholds): Sidecar {
  const recorded = { supersede_threshold: thresholds.supersedeThreshold, noop_threshold: thresholds.noopThreshold };
  if (classification.kind === "supersede_offer") {
    return { dedup: "supersede_offer", nearest_id: classification.neighborId, similarity: classification.similarity, degraded: false, ...recorded };
  }
  return { dedup: "add", nearest_id: null, similarity: null, degraded: classification.degraded, ...recorded };
}

export function writeSidecar(corpus: Corpus, id: string, sidecar: Sidecar): void {
  writeFileSync(sidecarPath(corpus, id), JSON.stringify(sidecar, null, 2) + "\n");
}

export function readSidecar(corpus: Corpus, id: string): Sidecar | undefined {
  const path = sidecarPath(corpus, id);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Sidecar;
}

export function removeSidecar(corpus: Corpus, id: string): void {
  rmSync(sidecarPath(corpus, id), { force: true });
}

// A degraded sidecar (embedder was down, so dedup never ran) and an absent sidecar both mean the
// dedup verdict is unknowable — never conflate that with "dedup ran and found no close neighbor".
export function dedupSummary(sidecar: Sidecar | undefined): DedupSummary {
  if (sidecar === undefined || sidecar.degraded) return { kind: "unavailable" };
  if (sidecar.nearest_id === null || sidecar.similarity === null) return { kind: "no_neighbor" };
  return { kind: "neighbor", nearestId: sidecar.nearest_id, similarity: sidecar.similarity };
}
