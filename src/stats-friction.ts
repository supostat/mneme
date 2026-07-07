import type { StoredEvent } from "./events";
import { isResolveEvent, isStagingEvent } from "./event-dialect";

// Review-friction metrics derived from the event log's resolution events, kept apart from stats.ts so
// each aggregator stays under the per-file cap. Two resolutions of the SAME note (an accept/supersede
// replay re-emits a resolve with a recomputed, inflated latency) are collapsed to the earliest before
// any measurement, so neither the latency percentiles nor the batch clustering double-counts a replay.

// Resolutions within five minutes of one another in a session are treated as one review sitting.
export const RESOLVE_BATCH_GAP_MS = 5 * 60_000;

const MEDIAN_PERCENTILE = 0.5;
const P90_PERCENTILE = 0.9;

export interface DurationPercentiles {
  count: number;
  median: number | null;
  p90: number | null;
}

export interface BatchSizes {
  bySize: Record<number, number>;
  batchCount: number;
}

export interface FrictionSummary {
  durations: DurationPercentiles;
  batches: BatchSizes;
  toolErrors: Record<string, number>;
}

interface ResolveRecord {
  noteId: string | null;
  sessionId: string | null;
  ts: string | null;
  loggedMs: number | null;
  order: number;
}

export function computeFriction(events: StoredEvent[]): FrictionSummary {
  const resolves = collapseReplayDuplicates(collectResolves(events));
  const stagingTs = collectStagingTs(events);
  return {
    durations: percentiles(resolveDurations(resolves, stagingTs)),
    batches: clusterBatches(resolves),
    toolErrors: countToolErrors(events),
  };
}

function collectResolves(events: StoredEvent[]): ResolveRecord[] {
  const resolves: ResolveRecord[] = [];
  events.forEach((event, order) => {
    if (!isResolveEvent(event)) return;
    resolves.push({
      noteId: typeof event.note_id === "string" ? event.note_id : null,
      sessionId: event.session_id,
      ts: event.ts,
      loggedMs: typeof event.staged_to_resolved_ms === "number" ? event.staged_to_resolved_ms : null,
      order,
    });
  });
  return resolves;
}

// Per note_id keep the single earliest resolution: earliest timestamp (a null ts always loses), then
// the smaller logged latency, then the earliest log position. A null note_id cannot be keyed and is
// dropped — a resolution always names its note.
function collapseReplayDuplicates(resolves: ResolveRecord[]): ResolveRecord[] {
  const earliestByNote = new Map<string, ResolveRecord>();
  for (const resolve of resolves) {
    if (resolve.noteId === null) continue;
    const incumbent = earliestByNote.get(resolve.noteId);
    if (incumbent === undefined || resolveRank(resolve, incumbent) < 0) {
      earliestByNote.set(resolve.noteId, resolve);
    }
  }
  return [...earliestByNote.values()];
}

function resolveRank(candidate: ResolveRecord, incumbent: ResolveRecord): number {
  const byTs = compareTs(candidate.ts, incumbent.ts);
  if (byTs !== 0) return byTs;
  const byMs = compareMs(candidate.loggedMs, incumbent.loggedMs);
  if (byMs !== 0) return byMs;
  return candidate.order - incumbent.order;
}

function compareTs(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function compareMs(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function resolveDurations(resolves: ResolveRecord[], stagingTs: Map<string, string>): number[] {
  const durations: number[] = [];
  for (const resolve of resolves) {
    const duration = resolveDuration(resolve, stagingTs);
    if (duration !== null) durations.push(duration);
  }
  return durations;
}

// The v2 latency is logged directly; a v1 resolve derives it from the interval between its own
// timestamp and its note's earliest staging anchor, and only when both parse and the interval is
// non-negative.
function resolveDuration(resolve: ResolveRecord, stagingTs: Map<string, string>): number | null {
  if (resolve.loggedMs !== null) return resolve.loggedMs;
  if (resolve.ts === null || resolve.noteId === null) return null;
  const staged = stagingTs.get(resolve.noteId);
  if (staged === undefined) return null;
  const resolvedAt = Date.parse(resolve.ts);
  const stagedAt = Date.parse(staged);
  if (Number.isNaN(resolvedAt) || Number.isNaN(stagedAt)) return null;
  const interval = resolvedAt - stagedAt;
  return interval >= 0 ? interval : null;
}

// Mirrors the private staging-anchor collector in stats.ts: the earliest staging timestamp per note,
// unioning note_staged (v1) with a non-noop remember (v2).
function collectStagingTs(events: StoredEvent[]): Map<string, string> {
  const stagingTs = new Map<string, string>();
  for (const event of events) {
    if (!isStagingEvent(event)) continue;
    if (typeof event.note_id !== "string" || typeof event.ts !== "string") continue;
    const incumbent = stagingTs.get(event.note_id);
    if (incumbent === undefined || event.ts < incumbent) stagingTs.set(event.note_id, event.ts);
  }
  return stagingTs;
}

function percentiles(durations: number[]): DurationPercentiles {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    count: sorted.length,
    median: nearestRank(sorted, MEDIAN_PERCENTILE),
    p90: nearestRank(sorted, P90_PERCENTILE),
  };
}

function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[rank - 1] ?? null;
}

// A batch is a run of resolutions in one session whose successive timestamps stay within the gap; a
// gap strictly greater than the constant starts a new batch. Resolutions without a session or a
// timestamp cannot be placed on a session timeline and are excluded from clustering.
function clusterBatches(resolves: ResolveRecord[]): BatchSizes {
  const bySession = groupBySession(resolves.filter((r) => r.sessionId !== null && r.ts !== null));
  const bySize: Record<number, number> = {};
  let batchCount = 0;
  for (const sessionResolves of bySession.values()) {
    for (const size of batchSizes(sessionResolves)) {
      bySize[size] = (bySize[size] ?? 0) + 1;
      batchCount += 1;
    }
  }
  return { bySize, batchCount };
}

function groupBySession(resolves: ResolveRecord[]): Map<string, ResolveRecord[]> {
  const bySession = new Map<string, ResolveRecord[]>();
  for (const resolve of resolves) {
    const sessionId = resolve.sessionId!;
    const bucket = bySession.get(sessionId);
    if (bucket === undefined) bySession.set(sessionId, [resolve]);
    else bucket.push(resolve);
  }
  return bySession;
}

function batchSizes(resolves: ResolveRecord[]): number[] {
  const sorted = [...resolves].sort(compareByTsThenNote);
  const sizes: number[] = [];
  let currentSize = 0;
  let previousMs: number | null = null;
  for (const resolve of sorted) {
    const ms = Date.parse(resolve.ts!);
    if (previousMs !== null && ms - previousMs > RESOLVE_BATCH_GAP_MS) {
      sizes.push(currentSize);
      currentSize = 0;
    }
    currentSize += 1;
    previousMs = ms;
  }
  if (currentSize > 0) sizes.push(currentSize);
  return sizes;
}

function compareByTsThenNote(left: ResolveRecord, right: ResolveRecord): number {
  const leftTs = left.ts ?? "";
  const rightTs = right.ts ?? "";
  if (leftTs !== rightTs) return leftTs < rightTs ? -1 : 1;
  const leftNote = left.noteId ?? "";
  const rightNote = right.noteId ?? "";
  return leftNote < rightNote ? -1 : leftNote > rightNote ? 1 : 0;
}

function countToolErrors(events: StoredEvent[]): Record<string, number> {
  const byTool: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "tool_error") continue;
    const tool = typeof event.tool === "string" ? event.tool : "";
    byTool[tool] = (byTool[tool] ?? 0) + 1;
  }
  return byTool;
}

export function formatFriction(summary: FrictionSummary): string {
  return [
    "Review friction (from the event log)",
    "",
    `(d) Staged -> resolved latency: ${renderLatency(summary.durations)}`,
    `(e) Resolution batch sizes: ${renderBatches(summary.batches)}`,
    `(f) Tool errors: ${renderToolErrors(summary.toolErrors)}`,
  ].join("\n");
}

function renderLatency(durations: DurationPercentiles): string {
  if (durations.median === null || durations.p90 === null) return "n/a (0 resolutions)";
  return `median ${durations.median} ms, p90 ${durations.p90} ms (${durations.count} resolutions)`;
}

function renderBatches(batches: BatchSizes): string {
  if (batches.batchCount === 0) return "n/a (0 batches)";
  const parts = Object.keys(batches.bySize)
    .map((size) => Number(size))
    .sort((left, right) => left - right)
    .map((size) => `${batches.bySize[size]}×${size}`);
  return `${batches.batchCount} batches [${parts.join(", ")}]`;
}

function renderToolErrors(byTool: Record<string, number>): string {
  const tools = Object.keys(byTool).sort();
  if (tools.length === 0) return "none";
  return tools.map((tool) => `${tool === "" ? "(untyped)" : tool}: ${byTool[tool]}`).join(", ");
}
