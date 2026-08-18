import type { StoredEvent } from "./events";
import { isResolveEvent, isStagingEvent } from "./event-dialect";
import { RESOLVE_BATCH_GAP_MS } from "./stats-friction";

// Human-gate metrics derived from the event log, kept apart from the stats trio so each aggregator
// stays under the per-file cap and inside the same discipline: only StoredEvent in, no I/O, no
// event emission, ts ordered as an opaque string (Date.parse appears solely for millisecond
// arithmetic, guarded against NaN). Everything here reads records the write path already stamped —
// the reader never opens notes/ and never renders into agent-facing text.

// The schema version that introduced menu/accepted_* stamping; coverage denominators start here so
// the pre-instrumentation era reads as "not measured", never as 0% coverage.
export const GATE_INSTRUMENTATION_SCHEMA_VERSION = 14;

const MEDIAN_PERCENTILE = 0.5;
const P90_PERCENTILE = 0.9;

export interface GateOutcomes {
  acceptedAsIs: number;
  acceptedEdited: number;
  // Accepts whose staged or accepted measures are missing (pre-v14 records): honestly unmeasurable,
  // never folded into "as-is" — that would fake a 0-edits reading.
  acceptedUnmeasured: number;
  rejected: number;
  superseded: number;
  deferred: number;
  silenceEpisodes: number;
}

export interface AgreementSlice {
  decisionClass: string;
  recommendedPosition: number;
  optionsN: number;
  decisions: number;
  agreed: number;
}

export interface GateCoverage {
  instrumentedResolves: number;
  eraResolves: number;
  preInstrumentation: number;
}

export interface ActiveLatency {
  count: number;
  median: number | null;
  p90: number | null;
}

export interface GateAuditSummary {
  outcomes: GateOutcomes;
  agreement: AgreementSlice[];
  coverage: GateCoverage;
  activeLatency: ActiveLatency;
}

interface MenuRecord {
  decision_class: string;
  options_n: number;
  recommended_position: number;
  chosen_position: number;
}

export function computeGateAudit(events: StoredEvent[]): GateAuditSummary {
  const sittings = reviewSittings(events);
  return {
    outcomes: computeOutcomes(events, sittings.silenceEpisodes),
    agreement: computeAgreement(events),
    coverage: computeCoverage(events),
    activeLatency: percentiles(sittings.latencies),
  };
}

function menuOf(event: StoredEvent): MenuRecord | null {
  const menu = event.menu;
  if (typeof menu !== "object" || menu === null) return null;
  const record = menu as Partial<MenuRecord>;
  if (typeof record.decision_class !== "string") return null;
  if (typeof record.options_n !== "number") return null;
  if (typeof record.recommended_position !== "number") return null;
  if (typeof record.chosen_position !== "number") return null;
  return record as MenuRecord;
}

function decisionOf(event: StoredEvent): string | null {
  if (event.type === "note_accepted") return "accept";
  if (event.type === "note_rejected") return "reject";
  if (event.type === "note_superseded") return "supersede";
  return typeof event.decision === "string" ? event.decision : null;
}

// Earliest resolution per note (a replayed resolve must not double-count): earliest ts wins, a
// null ts loses, log position breaks ties — the stats-friction collapse discipline.
function earliestResolvePerNote(events: StoredEvent[]): StoredEvent[] {
  const earliest = new Map<string, { event: StoredEvent; order: number }>();
  events.forEach((event, order) => {
    if (!isResolveEvent(event) || typeof event.note_id !== "string") return;
    const incumbent = earliest.get(event.note_id);
    if (incumbent === undefined || compareTs(event.ts, incumbent.event.ts) < 0) {
      earliest.set(event.note_id, { event, order });
    }
  });
  return [...earliest.values()].map((entry) => entry.event);
}

function compareTs(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function computeOutcomes(events: StoredEvent[], silenceEpisodes: number): GateOutcomes {
  const outcomes: GateOutcomes = {
    acceptedAsIs: 0,
    acceptedEdited: 0,
    acceptedUnmeasured: 0,
    rejected: 0,
    superseded: 0,
    deferred: 0,
    silenceEpisodes,
  };
  const stagedMeasures = collectStagedMeasures(events);
  const resolves = earliestResolvePerNote(events);
  for (const resolve of resolves) {
    const decision = decisionOf(resolve);
    if (decision === "reject") outcomes.rejected += 1;
    else if (decision === "supersede") outcomes.superseded += 1;
    else if (decision === "accept") classifyAccept(outcomes, resolve, stagedMeasures);
  }
  outcomes.deferred = countDeferred(events, new Set(resolves.map((event) => event.note_id as string)));
  return outcomes;
}

// The edit heuristic compares two records of ONE log: the staging remember's measures against the
// accepted_* the producer stamped at accept time. It is honestly FALSE-NEGATIVE: an edit that
// preserves both the code-point body length and the anchor count is invisible by construction.
function classifyAccept(
  outcomes: GateOutcomes,
  resolve: StoredEvent,
  stagedMeasures: Map<string, { bodyLen: number; anchorsN: number }>,
): void {
  const staged = typeof resolve.note_id === "string" ? stagedMeasures.get(resolve.note_id) : undefined;
  const acceptedBodyLen = typeof resolve.accepted_body_len === "number" ? resolve.accepted_body_len : null;
  const acceptedAnchorsN = typeof resolve.accepted_anchors_n === "number" ? resolve.accepted_anchors_n : null;
  if (staged === undefined || acceptedBodyLen === null || acceptedAnchorsN === null) {
    outcomes.acceptedUnmeasured += 1;
    return;
  }
  if (staged.bodyLen !== acceptedBodyLen || staged.anchorsN !== acceptedAnchorsN) {
    outcomes.acceptedEdited += 1;
  } else {
    outcomes.acceptedAsIs += 1;
  }
}

// Earliest staging measures per note; only events that carry both numbers qualify (legacy
// note_staged events without them simply leave the note unmeasurable).
function collectStagedMeasures(events: StoredEvent[]): Map<string, { bodyLen: number; anchorsN: number }> {
  const measures = new Map<string, { bodyLen: number; anchorsN: number; ts: string | null }>();
  for (const event of events) {
    if (!isStagingEvent(event) || typeof event.note_id !== "string") continue;
    if (typeof event.body_len !== "number" || typeof event.anchors_n !== "number") continue;
    const incumbent = measures.get(event.note_id);
    if (incumbent === undefined || compareTs(event.ts, incumbent.ts) < 0) {
      measures.set(event.note_id, { bodyLen: event.body_len, anchorsN: event.anchors_n, ts: event.ts });
    }
  }
  return new Map([...measures].map(([id, entry]) => [id, { bodyLen: entry.bodyLen, anchorsN: entry.anchorsN }]));
}

// Deferred = staged, never resolved, and the staging session is OVER (its session_end appeared, or
// a later session started). A note pending in the still-open final session is not deferred — the
// human may simply not have answered yet.
function countDeferred(events: StoredEvent[], resolvedIds: Set<string>): number {
  let deferred = 0;
  for (const event of events) {
    if (!isStagingEvent(event) || typeof event.note_id !== "string") continue;
    if (resolvedIds.has(event.note_id)) continue;
    if (sessionClosedAfter(events, event.session_id, event.ts)) deferred += 1;
  }
  return deferred;
}

function sessionClosedAfter(events: StoredEvent[], sessionId: string | null, ts: string | null): boolean {
  if (ts === null) return false;
  return events.some((event) => {
    if (typeof event.ts !== "string" || !(event.ts > ts)) return false;
    if (event.type === "session_end") return sessionId === null || event.session_id === sessionId;
    return event.type === "session_start";
  });
}

interface SittingScan {
  latencies: number[];
  silenceEpisodes: number;
}

// Walks each session's timeline: a staging_listed with a non-empty queue opens a "sitting"; the
// next resolve in the SAME session answers it (one latency sample), and a sitting still open when
// the session closes is one SILENCE episode. An open-ended final session is neither — the human
// may still be thinking, so it stays uncounted (never noise).
function reviewSittings(events: StoredEvent[]): SittingScan {
  const latencies: number[] = [];
  let silenceEpisodes = 0;
  for (const [sessionId, sessionEvents] of groupBySession(events)) {
    let pendingListedTs: string | null = null;
    for (const event of sessionEvents) {
      if (event.type === "staging_listed" && typeof event.count === "number" && event.count > 0) {
        if (pendingListedTs === null) pendingListedTs = event.ts;
      } else if (isResolveEvent(event) && pendingListedTs !== null) {
        const sample = intervalMs(pendingListedTs, event.ts);
        if (sample !== null) latencies.push(sample);
        pendingListedTs = null;
      }
    }
    if (pendingListedTs !== null && sessionClosedAfter(events, sessionId, pendingListedTs)) {
      silenceEpisodes += 1;
    }
  }
  return { latencies, silenceEpisodes };
}

function groupBySession(events: StoredEvent[]): Map<string, StoredEvent[]> {
  const bySession = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (event.session_id === null || event.ts === null) continue;
    const bucket = bySession.get(event.session_id);
    if (bucket === undefined) bySession.set(event.session_id, [event]);
    else bucket.push(event);
  }
  for (const bucket of bySession.values()) {
    bucket.sort((left, right) => compareTs(left.ts, right.ts));
  }
  return bySession;
}

function intervalMs(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  const interval = toMs - fromMs;
  return interval >= 0 ? interval : null;
}

// A batch "accept all" is N resolve calls carrying the IDENTICAL menu payload inside one review
// sitting; counting each call would inflate agreement by the batch size, so consecutive same-payload
// resolves within RESOLVE_BATCH_GAP_MS of one session collapse into ONE decision.
function computeAgreement(events: StoredEvent[]): AgreementSlice[] {
  const slices = new Map<string, AgreementSlice>();
  for (const sessionEvents of groupBySession(events).values()) {
    let previousKey: string | null = null;
    let previousMs: number | null = null;
    for (const event of sessionEvents) {
      if (event.type !== "staging_resolve") continue;
      const menu = menuOf(event);
      if (menu === null) {
        previousKey = null;
        previousMs = null;
        continue;
      }
      const payloadKey = `${menu.decision_class}|${menu.options_n}|${menu.recommended_position}|${menu.chosen_position}`;
      const ms = event.ts === null ? null : Date.parse(event.ts);
      const withinGap =
        previousMs !== null && ms !== null && !Number.isNaN(ms) && ms - previousMs <= RESOLVE_BATCH_GAP_MS;
      if (payloadKey !== previousKey || !withinGap) {
        recordDecision(slices, menu);
      }
      previousKey = payloadKey;
      previousMs = ms !== null && !Number.isNaN(ms) ? ms : null;
    }
  }
  return [...slices.values()].sort(compareSlices);
}

function recordDecision(slices: Map<string, AgreementSlice>, menu: MenuRecord): void {
  const key = `${menu.decision_class}|${menu.recommended_position}|${menu.options_n}`;
  const slice = slices.get(key) ?? {
    decisionClass: menu.decision_class,
    recommendedPosition: menu.recommended_position,
    optionsN: menu.options_n,
    decisions: 0,
    agreed: 0,
  };
  slice.decisions += 1;
  if (menu.chosen_position === menu.recommended_position) slice.agreed += 1;
  slices.set(key, slice);
}

function compareSlices(left: AgreementSlice, right: AgreementSlice): number {
  if (left.decisionClass !== right.decisionClass) return left.decisionClass < right.decisionClass ? -1 : 1;
  if (left.recommendedPosition !== right.recommendedPosition) return left.recommendedPosition - right.recommendedPosition;
  return left.optionsN - right.optionsN;
}

// Coverage guards the piggyback's one hole ("the call happened, the field stayed empty"): the share
// of v14+ resolves that carry a menu. Resolves stamped before v14 are a separate pre-instrumentation
// line — including them in the denominator would misread history as 0% coverage.
function computeCoverage(events: StoredEvent[]): GateCoverage {
  let instrumentedResolves = 0;
  let eraResolves = 0;
  let preInstrumentation = 0;
  for (const event of events) {
    if (!isResolveEvent(event)) continue;
    if (event.schema_version < GATE_INSTRUMENTATION_SCHEMA_VERSION) {
      preInstrumentation += 1;
      continue;
    }
    eraResolves += 1;
    if (menuOf(event) !== null) instrumentedResolves += 1;
  }
  return { instrumentedResolves, eraResolves, preInstrumentation };
}

function percentiles(latencies: number[]): ActiveLatency {
  const sorted = [...latencies].sort((left, right) => left - right);
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

export function formatGateAudit(summary: GateAuditSummary): string {
  return [
    "Human gate (from the event log)",
    "",
    `(g) Resolution outcomes: ${renderOutcomes(summary.outcomes)}`,
    `(h) Recommendation agreement: ${renderAgreement(summary.agreement)}`,
    `(i) Menu coverage: ${renderCoverage(summary.coverage)}`,
    `(j) Active review latency: ${renderLatency(summary.activeLatency)}`,
  ].join("\n");
}

function renderOutcomes(outcomes: GateOutcomes): string {
  const parts = [
    `accepted as-is ${outcomes.acceptedAsIs}`,
    `accepted after edit ${outcomes.acceptedEdited}`,
    `rejected ${outcomes.rejected}`,
    `superseded ${outcomes.superseded}`,
    `deferred ${outcomes.deferred}`,
    `silence episodes ${outcomes.silenceEpisodes}`,
  ];
  if (outcomes.acceptedUnmeasured > 0) {
    parts.push(`accepted pre-instrumentation ${outcomes.acceptedUnmeasured}`);
  }
  return parts.join(", ");
}

function renderAgreement(slices: AgreementSlice[]): string {
  if (slices.length === 0) return "n/a (0 instrumented decisions)";
  const decisions = slices.reduce((sum, slice) => sum + slice.decisions, 0);
  const agreed = slices.reduce((sum, slice) => sum + slice.agreed, 0);
  const detail = slices
    .map((slice) => `${slice.decisionClass} rec@${slice.recommendedPosition}/${slice.optionsN}: ${slice.agreed}/${slice.decisions}`)
    .join(", ");
  return `${agreed}/${decisions} overall [${detail}]`;
}

function renderCoverage(coverage: GateCoverage): string {
  const era =
    coverage.eraResolves === 0
      ? "n/a (0 resolves in the instrumented era)"
      : `${coverage.instrumentedResolves}/${coverage.eraResolves} resolves carry a menu`;
  return `${era}; pre-instrumentation: ${coverage.preInstrumentation} events`;
}

function renderLatency(latency: ActiveLatency): string {
  if (latency.median === null || latency.p90 === null) return "n/a (0 answered sittings)";
  return `median ${latency.median} ms, p90 ${latency.p90} ms (${latency.count} sittings)`;
}
