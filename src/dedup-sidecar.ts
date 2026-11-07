import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "./corpus";
import type { DedupClassification, DedupThresholds } from "./dedup";
import type { JudgeVerdict } from "./dedup-judge";

const SIDECAR_EXTENSION = ".dedup.json";

export type StagedClassification = Exclude<DedupClassification, { kind: "noop" }>;

// judge is the verdict on the nearest neighbour, whatever the cosine outcome: an `add` keeps
// nearest_id null (below the offer threshold) and yet may carry a recommendation, because the
// verdict names its own neighbour. null = no judge configured.
export interface Sidecar {
  dedup: "add" | "supersede_offer";
  nearest_id: string | null;
  similarity: number | null;
  degraded: boolean;
  supersede_threshold: number;
  noop_threshold: number;
  judge: JudgeVerdict | null;
}

// no_neighbor carries the judge too: "no CLOSE neighbor" means below the cosine offer threshold, and
// that is exactly where the judge earns its place — the probe's real supersedes mostly sat there.
export type DedupSummary =
  | { kind: "unavailable" }
  | { kind: "no_neighbor"; judge: JudgeVerdict | null }
  | { kind: "neighbor"; nearestId: string; similarity: number; judge: JudgeVerdict | null };

function sidecarPath(corpus: Corpus, id: string): string {
  return join(corpus.stagingDir, `${id}${SIDECAR_EXTENSION}`);
}

export function sidecarFor(
  classification: StagedClassification,
  thresholds: DedupThresholds,
  judge: JudgeVerdict | null,
): Sidecar {
  const recorded = { supersede_threshold: thresholds.supersedeThreshold, noop_threshold: thresholds.noopThreshold, judge };
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
// A sidecar written before v24 carries no judge key at all; it reads as "no judge", like null.
export function dedupSummary(sidecar: Sidecar | undefined): DedupSummary {
  if (sidecar === undefined || sidecar.degraded) return { kind: "unavailable" };
  const judge = sidecar.judge ?? null;
  if (sidecar.nearest_id === null || sidecar.similarity === null) return { kind: "no_neighbor", judge };
  return { kind: "neighbor", nearestId: sidecar.nearest_id, similarity: sidecar.similarity, judge };
}
