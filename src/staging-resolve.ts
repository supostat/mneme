import { readEvents } from "./events";
import type { StoredEvent } from "./events";
import { isStagingEvent } from "./event-dialect";
import { DEDUP_OUTCOMES, REANCHOR_DECISIONS, RESOLVE_DECISIONS, RETAG_DECISIONS, RETIRE_DECISIONS } from "./event-schema";
import type { DecisionClass, DedupRelation, ReanchorSource } from "./event-schema";
import type { DedupThresholds } from "./dedup";
import type { JudgeVerdict } from "./dedup-judge";
import type { StagedClassification } from "./dedup-sidecar";
import type { StagingDeps, RememberInput } from "./staging";

// The event-log emission layer for the staging lifecycle: how a remember and a resolve record
// themselves. Kept apart from staging.ts (which owns the note I/O and git) so both stay under the
// per-file cap and the telemetry payloads live in one place.

// The digit-menu context a deciding call rode on (see the v14 changelog). Snake_case on purpose:
// the object lands in the event verbatim.
export interface MenuContext {
  decision_class: DecisionClass;
  options_n: number;
  recommended_position: number;
  chosen_position: number;
}

// The verdict as the log carries it (v24): one flat shape for both verdict kinds, with every answer
// field null under degraded. The neighbour is the event's own nearest_id, so it is not repeated here.
export interface JudgeEventPayload {
  model: string;
  relation: DedupRelation | null;
  probabilities: Record<DedupRelation, number> | null;
  confidence: number | null;
  recommended: boolean | null;
  degraded: boolean;
}

interface DedupEventPayload {
  outcome: (typeof DEDUP_OUTCOMES)[number];
  nearest_id: string | null;
  similarity: number | null;
  supersede_threshold: number;
  noop_threshold: number;
  degraded: boolean;
  judge: JudgeEventPayload | null;
}

export function judgeEventPayload(verdict: JudgeVerdict | null): JudgeEventPayload | null {
  if (verdict === null) {
    return null;
  }
  if (verdict.degraded) {
    return { model: verdict.model, relation: null, probabilities: null, confidence: null, recommended: null, degraded: true };
  }
  return {
    model: verdict.model,
    relation: verdict.relation,
    probabilities: verdict.probabilities,
    confidence: verdict.confidence,
    recommended: verdict.recommended,
    degraded: false,
  };
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
    tags_n: (input.tags ?? []).length,
    tags: input.tags ?? [],
    source: input.source,
    dedup,
    menu: input.menu ?? null,
  });
}

export function dedupPayload(
  outcome: DedupEventPayload["outcome"],
  nearestId: string | null,
  similarity: number | null,
  degraded: boolean,
  thresholds: DedupThresholds,
  judge: JudgeVerdict | null,
): DedupEventPayload {
  return {
    outcome,
    nearest_id: nearestId,
    similarity,
    supersede_threshold: thresholds.supersedeThreshold,
    noop_threshold: thresholds.noopThreshold,
    degraded,
    judge: judgeEventPayload(judge),
  };
}

export function dedupFromClassification(
  classification: StagedClassification,
  thresholds: DedupThresholds,
  judge: JudgeVerdict | null,
): DedupEventPayload {
  if (classification.kind === "supersede_offer") {
    return dedupPayload("supersede_suggest", classification.neighborId, classification.similarity, false, thresholds, judge);
  }
  return dedupPayload("add", classification.neighborId, classification.similarity, classification.degraded, thresholds, judge);
}

export function appendRetireStaged(deps: StagingDeps, requestId: string, targetId: string, reason: string): void {
  deps.eventWriter.append({
    type: "note_retire_staged",
    request_id: requestId,
    target_id: targetId,
    reason,
  });
}

export function appendRetireResolved(
  deps: StagingDeps,
  requestId: string,
  targetId: string,
  decision: (typeof RETIRE_DECISIONS)[number],
  commit: string | null,
): void {
  deps.eventWriter.append({
    type: "note_retire_resolved",
    request_id: requestId,
    target_id: targetId,
    decision,
    commit,
  });
}

export interface ReanchorStagedPayload {
  requestId: string;
  targetId: string;
  oldAnchor: string;
  newAnchor: string;
  score: number | null;
  source: ReanchorSource;
}

export function appendReanchorStaged(deps: StagingDeps, payload: ReanchorStagedPayload): void {
  deps.eventWriter.append({
    type: "note_reanchor_staged",
    request_id: payload.requestId,
    target_id: payload.targetId,
    old_anchor: payload.oldAnchor,
    new_anchor: payload.newAnchor,
    score: payload.score,
    source: payload.source,
  });
}

export function appendRetagStaged(deps: StagingDeps, requestId: string, targetId: string, anchor: string): void {
  deps.eventWriter.append({
    type: "note_retag_staged",
    request_id: requestId,
    target_id: targetId,
    anchor,
  });
}

export function appendRetagResolved(
  deps: StagingDeps,
  requestId: string,
  targetId: string,
  decision: (typeof RETAG_DECISIONS)[number],
  commit: string | null,
): void {
  deps.eventWriter.append({
    type: "note_retag_resolved",
    request_id: requestId,
    target_id: targetId,
    decision,
    commit,
  });
}

export function appendReanchorResolved(
  deps: StagingDeps,
  requestId: string,
  targetId: string,
  decision: (typeof REANCHOR_DECISIONS)[number],
  commit: string | null,
): void {
  deps.eventWriter.append({
    type: "note_reanchor_resolved",
    request_id: requestId,
    target_id: targetId,
    decision,
    commit,
  });
}

interface StagingResolveExtra {
  commit: string | null;
  superseded_id: string | null;
  suggested: boolean | null;
  accepted_body_len: number | null;
  accepted_anchors_n: number | null;
  menu: MenuContext | null;
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
    accepted_body_len: extra.accepted_body_len,
    accepted_anchors_n: extra.accepted_anchors_n,
    menu: extra.menu,
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
