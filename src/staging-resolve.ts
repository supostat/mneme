import { readEvents } from "./events";
import type { StoredEvent } from "./events";
import { isStagingEvent } from "./event-dialect";
import { DEDUP_OUTCOMES, RESOLVE_DECISIONS } from "./event-schema";
import type { DedupThresholds } from "./dedup";
import type { StagedClassification } from "./dedup-sidecar";
import type { StagingDeps, RememberInput } from "./staging";

// The event-log emission layer for the staging lifecycle: how a remember and a resolve record
// themselves. Kept apart from staging.ts (which owns the note I/O and git) so both stay under the
// per-file cap and the telemetry payloads live in one place.

interface DedupEventPayload {
  outcome: (typeof DEDUP_OUTCOMES)[number];
  nearest_id: string | null;
  similarity: number | null;
  supersede_threshold: number;
  noop_threshold: number;
  degraded: boolean;
}

export function emitRemember(
  deps: StagingDeps,
  noteId: string,
  input: RememberInput,
  dedup: DedupEventPayload,
): void {
  deps.eventWriter.append({
    type: "remember",
    note_id: noteId,
    note_type: input.type,
    body_len: [...input.body].length,
    anchors_n: input.anchors.length,
    source: input.source,
    dedup,
  });
}

export function dedupPayload(
  outcome: DedupEventPayload["outcome"],
  nearestId: string | null,
  similarity: number | null,
  degraded: boolean,
  thresholds: DedupThresholds,
): DedupEventPayload {
  return {
    outcome,
    nearest_id: nearestId,
    similarity,
    supersede_threshold: thresholds.supersedeThreshold,
    noop_threshold: thresholds.noopThreshold,
    degraded,
  };
}

export function dedupFromClassification(
  classification: StagedClassification,
  thresholds: DedupThresholds,
): DedupEventPayload {
  if (classification.kind === "supersede_offer") {
    return dedupPayload("supersede_suggest", classification.neighborId, classification.similarity, false, thresholds);
  }
  return dedupPayload("add", classification.neighborId, classification.similarity, classification.degraded, thresholds);
}

interface StagingResolveExtra {
  commit: string | null;
  superseded_id: string | null;
  suggested: boolean | null;
}

export function appendStagingResolve(
  deps: StagingDeps,
  id: string,
  decision: (typeof RESOLVE_DECISIONS)[number],
  extra: StagingResolveExtra,
): void {
  deps.eventWriter.append({
    type: "staging_resolve",
    note_id: id,
    decision,
    staged_to_resolved_ms: stagedToResolvedMs(deps, id),
    commit: extra.commit,
    superseded_id: extra.superseded_id,
    suggested: extra.suggested,
  });
}

// The staged-at instant is the note's own staging event in the log (single source of truth), never
// the frontmatter `created`. A note staged before schema v2 wears the legacy note_staged name; from
// v2 it is a remember event whose dedup outcome is not "noop" (a noop never staged anything).
function stagedToResolvedMs(deps: StagingDeps, id: string): number | null {
  let earliest: string | undefined;
  for (const event of readEvents(deps.corpus.eventsDir)) {
    if (!isStagingEventForNote(event, id) || typeof event.ts !== "string") continue;
    if (earliest === undefined || event.ts < earliest) earliest = event.ts;
  }
  if (earliest === undefined) return null;
  return deps.clock().getTime() - Date.parse(earliest);
}

function isStagingEventForNote(event: StoredEvent, id: string): boolean {
  return event.note_id === id && isStagingEvent(event);
}
