import type { StoredEvent } from "./events";

// Shared schema-v1/v2 dialect predicates over the tolerant StoredEvent shape. The event log mixes
// schema versions (a corpus that spanned the migration), so every consumer — the stats aggregator
// and the staging telemetry — classifies events through these readers rather than matching a single
// event name. They stay tolerant: an unrecognised shape simply fails the predicate, never throws.

function dedupOutcomeOf(event: StoredEvent): string | undefined {
  const dedup = event.dedup;
  if (typeof dedup !== "object" || dedup === null) return undefined;
  const outcome = (dedup as { outcome?: unknown }).outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

// A note_staged (v1) or a remember whose dedup outcome is not "noop" (v2) — a noop never staged a note.
export function isStagingEvent(event: StoredEvent): boolean {
  if (event.type === "note_staged") return true;
  return event.type === "remember" && dedupOutcomeOf(event) !== "noop";
}

// A note kept by its resolution: note_accepted (v1) or a staging_resolve accepting/superseding (v2).
export function isAcceptedEvent(event: StoredEvent): boolean {
  if (event.type === "note_accepted") return true;
  return event.type === "staging_resolve" && (event.decision === "accept" || event.decision === "supersede");
}

export function isSupersedeEvent(event: StoredEvent): boolean {
  if (event.type === "note_superseded") return true;
  return event.type === "staging_resolve" && event.decision === "supersede";
}

// A write-path re-encounter: note_deduped (v1) or a remember whose dedup outcome is "noop" (v2).
export function isNoopEvent(event: StoredEvent): boolean {
  if (event.type === "note_deduped") return true;
  return event.type === "remember" && dedupOutcomeOf(event) === "noop";
}

// Any resolution of a staged note: the three v1 decision names or a v2 staging_resolve of any
// decision. Friction analysis clusters and times resolutions regardless of the accept/reject/
// supersede outcome, so this predicate is decision-agnostic (unlike isAcceptedEvent).
export function isResolveEvent(event: StoredEvent): boolean {
  if (event.type === "note_accepted" || event.type === "note_rejected" || event.type === "note_superseded") {
    return true;
  }
  return event.type === "staging_resolve";
}
