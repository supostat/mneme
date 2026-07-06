import type { StoredEvent } from "./events";

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
    crossSessionReuse: crossSessionReuse(acceptedIds, stagingAnchors, recalls),
    neverRetrieved: neverRetrievedMetric.metric,
    degradationFrequency: degradation(recalls),
    corpusSizeByType: corpusSizeByType(liveAccepted, stagedTypes),
    noopConfirmations: noop.count,
    noopDistinctNoteCount: noop.distinctNoteCount,
    neverRetrievedSupersededCount: neverRetrievedMetric.supersededCount,
  };
}

function collectAcceptedIds(events: StoredEvent[]): Set<string> {
  const acceptedIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "note_accepted") continue;
    if (typeof event.note_id === "string") acceptedIds.add(event.note_id);
  }
  return acceptedIds;
}

function collectSupersededIds(events: StoredEvent[]): Set<string> {
  const supersededIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "note_superseded") continue;
    if (typeof event.superseded_id === "string") supersededIds.add(event.superseded_id);
  }
  return supersededIds;
}

function collectStagingAnchors(events: StoredEvent[]): Map<string, StagingAnchor> {
  const anchors = new Map<string, StagingAnchor>();
  for (const event of events) {
    if (event.type !== "note_staged") continue;
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
    if (event.type !== "note_staged") continue;
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
    });
  }
  return occurrences;
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
    if (event.type !== "note_deduped") continue;
    count += 1;
    if (typeof event.existing_id === "string") distinctExistingIds.add(event.existing_id);
  }
  return { count, distinctNoteCount: distinctExistingIds.size };
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
    `Recall events: ${summary.recallEventCount}`,
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
