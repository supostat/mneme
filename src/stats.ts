import type { StoredEvent } from "./events";
import { isAcceptedEvent, isSupersedeEvent, isStagingEvent, isNoopEvent } from "./event-dialect";
import { RECALL_ORIGINS, RECALL_ORIGIN_UNKNOWN } from "./event-schema";
import type { RecallOrigin } from "./event-schema";

type RecallOriginBucket = RecallOrigin | typeof RECALL_ORIGIN_UNKNOWN;

export interface RatioMetric {
  numerator: number;
  denominator: number;
  ratio: number | null;
}

export interface CorpusSizeByType {
  byType: Record<string, number>;
  untyped: number;
}

export interface StatsSummary {
  acceptedNoteCount: number;
  liveNoteCount: number;
  recallEventCount: number;
  recallByOrigin: Record<RecallOriginBucket, number>;
  crossSessionReuse: RatioMetric;
  neverRetrieved: RatioMetric;
  degradationFrequency: RatioMetric;
  corpusSizeByType: CorpusSizeByType;
  noopConfirmations: number;
  noopDistinctNoteCount: number;
  neverRetrievedSupersededCount: number;
}

interface StagingAnchor {
  sessionId: string | null;
  ts: string | null;
}

interface RecallOccurrence {
  sessionId: string | null;
  ts: string | null;
  returnedIds: string[];
  degraded: boolean;
  origin: RecallOriginBucket;
}

interface NoopSummary {
  count: number;
  distinctNoteCount: number;
}

export function computeStats(events: StoredEvent[]): StatsSummary {
  const acceptedIds = collectAcceptedIds(events);
  const supersededIds = collectSupersededIds(events);
  const stagingAnchors = collectStagingAnchors(events);
  const stagedTypes = collectStagedTypes(events);
  const recalls = collectRecallOccurrences(events);
  const liveAccepted = liveAcceptedIds(acceptedIds, supersededIds);
  const neverRetrievedMetric = neverRetrieved(acceptedIds, recalls, supersededIds);
  const noop = noopSummary(events);
  return {
    acceptedNoteCount: acceptedIds.size,
    liveNoteCount: liveAccepted.size,
    recallEventCount: recalls.length,
    recallByOrigin: recallByOrigin(recalls),
    crossSessionReuse: crossSessionReuse(acceptedIds, stagingAnchors, recalls),
    neverRetrieved: neverRetrievedMetric.metric,
    degradationFrequency: degradation(recalls),
    corpusSizeByType: corpusSizeByType(liveAccepted, stagedTypes),
    noopConfirmations: noop.count,
    noopDistinctNoteCount: noop.distinctNoteCount,
    neverRetrievedSupersededCount: neverRetrievedMetric.supersededCount,
  };
}

// Every collector unions the schema-v1 event names with their v2 successors (via ./event-dialect) so
// a log mixing both dialects reproduces identical counts. The aggregator is never gated on
// eventSchema — it stays tolerant and derives the dialect from the fields present.

function collectAcceptedIds(events: StoredEvent[]): Set<string> {
  const acceptedIds = new Set<string>();
  for (const event of events) {
    if (!isAcceptedEvent(event) || typeof event.note_id !== "string") continue;
    acceptedIds.add(event.note_id);
  }
  return acceptedIds;
}

function collectSupersededIds(events: StoredEvent[]): Set<string> {
  const supersededIds = new Set<string>();
  for (const event of events) {
    if (!isSupersedeEvent(event) || typeof event.superseded_id !== "string") continue;
    supersededIds.add(event.superseded_id);
  }
  return supersededIds;
}

function collectStagingAnchors(events: StoredEvent[]): Map<string, StagingAnchor> {
  const anchors = new Map<string, StagingAnchor>();
  for (const event of events) {
    if (!isStagingEvent(event)) continue;
    const noteId = event.note_id;
    if (typeof noteId !== "string") continue;
    const incumbent = anchors.get(noteId);
    if (incumbent === undefined || isStrictlyEarlier(event.ts, incumbent.ts)) {
      anchors.set(noteId, { sessionId: event.session_id, ts: event.ts });
    }
  }
  return anchors;
}

function collectStagedTypes(events: StoredEvent[]): Map<string, string> {
  const stagedTypes = new Map<string, string>();
  for (const event of events) {
    if (!isStagingEvent(event)) continue;
    const noteId = event.note_id;
    const noteType = event.note_type;
    if (typeof noteId !== "string" || typeof noteType !== "string") continue;
    if (!stagedTypes.has(noteId)) stagedTypes.set(noteId, noteType);
  }
  return stagedTypes;
}

function collectRecallOccurrences(events: StoredEvent[]): RecallOccurrence[] {
  const occurrences: RecallOccurrence[] = [];
  for (const event of events) {
    if (event.type !== "recall") continue;
    occurrences.push({
      sessionId: event.session_id,
      ts: event.ts,
      returnedIds: stringArray(event.returned_ids),
      degraded: event.degraded === true,
      origin: recallOriginBucket(event.origin),
    });
  }
  return occurrences;
}

// A recall event stamped before schema v5 carries no origin; its absence (or any unrecognized value)
// reads as "unknown" rather than crashing the aggregator or being silently dropped.
function recallOriginBucket(value: unknown): RecallOriginBucket {
  return RECALL_ORIGINS.includes(value as RecallOrigin) ? (value as RecallOrigin) : RECALL_ORIGIN_UNKNOWN;
}

function recallByOrigin(recalls: RecallOccurrence[]): Record<RecallOriginBucket, number> {
  const counts: Record<RecallOriginBucket, number> = {
    "workflow-step": 0,
    "tool-call": 0,
    [RECALL_ORIGIN_UNKNOWN]: 0,
  };
  for (const recall of recalls) counts[recall.origin] += 1;
  return counts;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((element): element is string => typeof element === "string");
}

function liveAcceptedIds(acceptedIds: Set<string>, supersededIds: Set<string>): Set<string> {
  const live = new Set<string>();
  for (const noteId of acceptedIds) {
    if (!supersededIds.has(noteId)) live.add(noteId);
  }
  return live;
}

function crossSessionReuse(
  acceptedIds: Set<string>,
  stagingAnchors: Map<string, StagingAnchor>,
  recalls: RecallOccurrence[],
): RatioMetric {
  let numerator = 0;
  for (const noteId of acceptedIds) {
    const anchor = stagingAnchors.get(noteId);
    if (anchor === undefined) continue;
    if (recalls.some((recall) => isCrossSessionReuse(noteId, anchor, recall))) numerator += 1;
  }
  return ratio(numerator, acceptedIds.size);
}

function isCrossSessionReuse(
  noteId: string,
  anchor: StagingAnchor,
  recall: RecallOccurrence,
): boolean {
  if (!recall.returnedIds.includes(noteId)) return false;
  if (typeof anchor.sessionId !== "string" || typeof recall.sessionId !== "string") return false;
  if (anchor.sessionId === recall.sessionId) return false;
  return isStrictlyEarlier(anchor.ts, recall.ts);
}

function neverRetrieved(
  acceptedIds: Set<string>,
  recalls: RecallOccurrence[],
  supersededIds: Set<string>,
): { metric: RatioMetric; supersededCount: number } {
  const retrieved = retrievedIds(recalls);
  let numerator = 0;
  let supersededCount = 0;
  for (const noteId of acceptedIds) {
    if (retrieved.has(noteId)) continue;
    numerator += 1;
    if (supersededIds.has(noteId)) supersededCount += 1;
  }
  return { metric: ratio(numerator, acceptedIds.size), supersededCount };
}

function retrievedIds(recalls: RecallOccurrence[]): Set<string> {
  const retrieved = new Set<string>();
  for (const recall of recalls) {
    for (const noteId of recall.returnedIds) retrieved.add(noteId);
  }
  return retrieved;
}

function degradation(recalls: RecallOccurrence[]): RatioMetric {
  const degraded = recalls.filter((recall) => recall.degraded).length;
  return ratio(degraded, recalls.length);
}

function corpusSizeByType(
  liveAccepted: Set<string>,
  stagedTypes: Map<string, string>,
): CorpusSizeByType {
  const byType: Record<string, number> = {};
  let untyped = 0;
  for (const noteId of liveAccepted) {
    const noteType = stagedTypes.get(noteId);
    if (noteType === undefined) {
      untyped += 1;
      continue;
    }
    byType[noteType] = (byType[noteType] ?? 0) + 1;
  }
  return { byType, untyped };
}

function noopSummary(events: StoredEvent[]): NoopSummary {
  let count = 0;
  const distinctExistingIds = new Set<string>();
  for (const event of events) {
    if (!isNoopEvent(event)) continue;
    count += 1;
    const existingId = noopExistingId(event);
    if (existingId !== undefined) distinctExistingIds.add(existingId);
  }
  return { count, distinctNoteCount: distinctExistingIds.size };
}

function noopExistingId(event: StoredEvent): string | undefined {
  if (event.type === "note_deduped") {
    return typeof event.existing_id === "string" ? event.existing_id : undefined;
  }
  const dedup = event.dedup;
  if (typeof dedup !== "object" || dedup === null) return undefined;
  const nearestId = (dedup as { nearest_id?: unknown }).nearest_id;
  return typeof nearestId === "string" ? nearestId : undefined;
}

function isStrictlyEarlier(candidate: string | null, reference: string | null): boolean {
  if (typeof candidate !== "string" || typeof reference !== "string") return false;
  return candidate < reference;
}

function ratio(numerator: number, denominator: number): RatioMetric {
  return { numerator, denominator, ratio: denominator === 0 ? null : numerator / denominator };
}

export function formatStats(summary: StatsSummary): string {
  return [
    "Mneme proof metrics (from the event log)",
    "",
    `Accepted notes (historical): ${summary.acceptedNoteCount}`,
    `Live notes (accepted minus superseded): ${summary.liveNoteCount}`,
    `Recall events: ${summary.recallEventCount} (engine ${summary.recallByOrigin["workflow-step"]}, manual ${summary.recallByOrigin["tool-call"]}, unknown ${summary.recallByOrigin[RECALL_ORIGIN_UNKNOWN]})`,
    "",
    `(a) Cross-session reuse: ${renderRatio(summary.crossSessionReuse, "accepted notes")}`,
    `(b) Never retrieved: ${renderRatio(summary.neverRetrieved, "accepted notes")} (of which ${summary.neverRetrievedSupersededCount} superseded)`,
    `(c) Recall degradation: ${renderRatio(summary.degradationFrequency, "recall events")}`,
    "",
    "Corpus size by type (live):",
    ...renderCorpusSizeByType(summary.corpusSizeByType),
    "",
    `NOOP confirmations: ${summary.noopConfirmations} (${summary.noopDistinctNoteCount} distinct notes) (write-path re-encounters of existing notes)`,
  ].join("\n");
}

function renderRatio(metric: RatioMetric, denominatorNoun: string): string {
  if (metric.ratio === null) return `n/a (0 ${denominatorNoun})`;
  return `${metric.numerator}/${metric.denominator} (${(metric.ratio * 100).toFixed(1)}%)`;
}

function renderCorpusSizeByType(corpus: CorpusSizeByType): string[] {
  const lines = Object.entries(corpus.byType)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([noteType, count]) => `  ${noteType}: ${count}`);
  if (corpus.untyped > 0) lines.push(`  untyped: ${corpus.untyped}`);
  if (lines.length === 0) return ["  (no live notes)"];
  return lines;
}
