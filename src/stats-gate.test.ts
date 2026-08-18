import { test, expect, describe } from "bun:test";
import type { StoredEvent } from "./events";
import { computeGateAudit, formatGateAudit, GATE_INSTRUMENTATION_SCHEMA_VERSION } from "./stats-gate";
import { RESOLVE_BATCH_GAP_MS } from "./stats-friction";

// Fixtures are hand-built StoredEvents: the reader takes the tolerant shape directly, so the tests
// pin its behavior on exactly the records the log holds — including pre-v14 ones without new keys.

const V14 = GATE_INSTRUMENTATION_SCHEMA_VERSION;

function at(seconds: number): string {
  return new Date(Date.parse("2026-08-18T10:00:00.000Z") + seconds * 1000).toISOString();
}

function event(
  type: string,
  session: string,
  ts: string,
  extra: Record<string, unknown> = {},
  schemaVersion: number = V14,
): StoredEvent {
  return { type, session_id: session, ts, mneme_version: "0.2.0", schema_version: schemaVersion, ...extra };
}

function staged(id: string, session: string, ts: string, bodyLen: number, anchorsN: number): StoredEvent {
  return event("remember", session, ts, {
    note_id: id,
    body_len: bodyLen,
    anchors_n: anchorsN,
    dedup: { outcome: "add" },
  });
}

function resolved(id: string, session: string, ts: string, extra: Record<string, unknown> = {}): StoredEvent {
  return event("staging_resolve", session, ts, {
    note_id: id,
    decision: "accept",
    accepted_body_len: null,
    accepted_anchors_n: null,
    menu: null,
    ...extra,
  });
}

const MENU = { decision_class: "curation", options_n: 4, recommended_position: 2, chosen_position: 2 };

describe("outcome taxonomy", () => {
  test("classifies all six outcomes from remember/resolve pairs", () => {
    const events = [
      // accepted as-is: measures match.
      staged("n-asis", "s1", at(0), 10, 1),
      resolved("n-asis", "s1", at(1), { accepted_body_len: 10, accepted_anchors_n: 1 }),
      // accepted after edit: body length changed between staging and accept.
      staged("n-edit", "s1", at(2), 10, 1),
      resolved("n-edit", "s1", at(3), { accepted_body_len: 14, accepted_anchors_n: 1 }),
      // rejected.
      staged("n-rej", "s1", at(4), 5, 1),
      resolved("n-rej", "s1", at(5), { decision: "reject" }),
      // superseded.
      staged("n-sup", "s1", at(6), 5, 1),
      resolved("n-sup", "s1", at(7), { decision: "supersede", accepted_body_len: 5, accepted_anchors_n: 1 }),
      // deferred: staged in s1, never resolved, and s1 ended.
      staged("n-def", "s1", at(8), 5, 1),
      // silence: queue shown, no resolve afterwards, session ends.
      event("staging_listed", "s1", at(9), { count: 1 }),
      event("session_end", "s1", at(10)),
    ];

    const outcomes = computeGateAudit(events).outcomes;

    expect(outcomes.acceptedAsIs).toBe(1);
    expect(outcomes.acceptedEdited).toBe(1);
    expect(outcomes.rejected).toBe(1);
    expect(outcomes.superseded).toBe(1);
    expect(outcomes.deferred).toBe(1);
    expect(outcomes.silenceEpisodes).toBe(1);
    expect(outcomes.acceptedUnmeasured).toBe(0);
  });

  test("a length-preserving edit is NOT detected — the false-negative pin", () => {
    const events = [
      // The body changed (one anchor swapped for another of the same length), but code-point length
      // and anchor count are identical: the heuristic must read this as "as-is", by construction.
      staged("n1", "s1", at(0), 10, 2),
      resolved("n1", "s1", at(1), { accepted_body_len: 10, accepted_anchors_n: 2 }),
    ];

    const outcomes = computeGateAudit(events).outcomes;

    expect(outcomes.acceptedEdited).toBe(0);
    expect(outcomes.acceptedAsIs).toBe(1);
  });

  test("an accept without measures on either side counts as unmeasured, never as-is", () => {
    const events = [
      event("note_staged", "s1", at(0), { note_id: "n1" }, 1),
      event("note_accepted", "s1", at(1), { note_id: "n1" }, 1),
    ];

    const outcomes = computeGateAudit(events).outcomes;

    expect(outcomes.acceptedUnmeasured).toBe(1);
    expect(outcomes.acceptedAsIs).toBe(0);
  });

  test("a replayed resolve does not double-count its note", () => {
    const events = [
      staged("n1", "s1", at(0), 10, 1),
      resolved("n1", "s1", at(1), { accepted_body_len: 10, accepted_anchors_n: 1 }),
      resolved("n1", "s1", at(2), { accepted_body_len: 10, accepted_anchors_n: 1 }),
    ];

    const outcomes = computeGateAudit(events).outcomes;

    expect(outcomes.acceptedAsIs).toBe(1);
  });

  test("a note pending in the still-open final session is neither deferred nor silence", () => {
    const events = [staged("n1", "s1", at(0), 5, 1), event("staging_listed", "s1", at(1), { count: 1 })];

    const outcomes = computeGateAudit(events).outcomes;

    expect(outcomes.deferred).toBe(0);
    expect(outcomes.silenceEpisodes).toBe(0);
  });
});

describe("silence closure", () => {
  test("silence closes via session_end and via the next session_start alike", () => {
    const events = [
      event("staging_listed", "s1", at(0), { count: 1 }),
      event("session_end", "s1", at(1)),
      event("session_start", "s2", at(2)),
      event("staging_listed", "s2", at(3), { count: 1 }),
      // s2 never emits session_end (cut off) — the s3 start closes it.
      event("session_start", "s3", at(4)),
    ];

    expect(computeGateAudit(events).outcomes.silenceEpisodes).toBe(2);
  });

  test("an answered sitting is not silence and yields one latency sample", () => {
    const events = [
      event("staging_listed", "s1", at(0), { count: 1 }),
      resolved("n1", "s1", at(60), { accepted_body_len: 1, accepted_anchors_n: 1 }),
      event("session_end", "s1", at(61)),
    ];

    const summary = computeGateAudit(events);

    expect(summary.outcomes.silenceEpisodes).toBe(0);
    expect(summary.activeLatency.count).toBe(1);
    expect(summary.activeLatency.median).toBe(60_000);
  });

  test("an empty queue listing opens no sitting", () => {
    const events = [event("staging_listed", "s1", at(0), { count: 0 }), event("session_end", "s1", at(1))];

    expect(computeGateAudit(events).outcomes.silenceEpisodes).toBe(0);
  });
});

describe("recommendation agreement", () => {
  test("slices by class, recommended position and menu size, counting matches", () => {
    const events = [
      resolved("n1", "s1", at(0), { menu: MENU }),
      resolved("n2", "s1", at(1000), { menu: { ...MENU, chosen_position: 1 } }),
      resolved("n3", "s1", at(2000), { menu: { decision_class: "plan-fan", options_n: 3, recommended_position: 1, chosen_position: 1 } }),
    ];

    const agreement = computeGateAudit(events).agreement;

    expect(agreement).toEqual([
      { decisionClass: "curation", recommendedPosition: 2, optionsN: 4, decisions: 2, agreed: 1 },
      { decisionClass: "plan-fan", recommendedPosition: 1, optionsN: 3, decisions: 1, agreed: 1 },
    ]);
  });

  test("a batch of identical payloads within the gap collapses into one decision", () => {
    const events = [
      resolved("n1", "s1", at(0), { menu: MENU }),
      resolved("n2", "s1", at(1), { menu: MENU }),
      resolved("n3", "s1", at(2), { menu: MENU }),
    ];

    const agreement = computeGateAudit(events).agreement;

    expect(agreement.length).toBe(1);
    expect(agreement[0]!.decisions).toBe(1);
    expect(agreement[0]!.agreed).toBe(1);
  });

  test("the same payload beyond the batch gap counts as a new decision", () => {
    const gapSeconds = (RESOLVE_BATCH_GAP_MS + 1000) / 1000;
    const events = [
      resolved("n1", "s1", at(0), { menu: MENU }),
      resolved("n2", "s1", at(gapSeconds), { menu: MENU }),
    ];

    expect(computeGateAudit(events).agreement[0]!.decisions).toBe(2);
  });

  test("an uninstrumented resolve between two identical payloads breaks the batch", () => {
    const events = [
      resolved("n1", "s1", at(0), { menu: MENU }),
      resolved("n2", "s1", at(1)),
      resolved("n3", "s1", at(2), { menu: MENU }),
    ];

    expect(computeGateAudit(events).agreement[0]!.decisions).toBe(2);
  });
});

describe("menu coverage", () => {
  test("counts only the instrumented era and reports the older one separately", () => {
    const events = [
      event("note_accepted", "s0", at(0), { note_id: "old1" }, 1),
      event("staging_resolve", "s0", at(1), { note_id: "old2", decision: "accept" }, 13),
      resolved("n1", "s1", at(2), { menu: MENU }),
      resolved("n2", "s1", at(3)),
    ];

    const coverage = computeGateAudit(events).coverage;

    expect(coverage.preInstrumentation).toBe(2);
    expect(coverage.eraResolves).toBe(2);
    expect(coverage.instrumentedResolves).toBe(1);
  });

  test("a pre-v14 log aggregates without errors and yields an empty era", () => {
    const events = [
      event("note_staged", "s1", at(0), { note_id: "n1" }, 1),
      event("note_accepted", "s1", at(1), { note_id: "n1" }, 1),
      event("staging_listed", "s1", at(2), { count: 1 }, 2),
      event("session_end", "s1", at(3), {}, 2),
    ];

    const summary = computeGateAudit(events);

    expect(summary.coverage.eraResolves).toBe(0);
    expect(summary.coverage.preInstrumentation).toBe(1);
    expect(summary.agreement).toEqual([]);
    expect(summary.outcomes.silenceEpisodes).toBe(1);
  });
});

describe("formatGateAudit", () => {
  test("renders every section and n/a placeholders on an empty log", () => {
    const text = formatGateAudit(computeGateAudit([]));

    expect(text).toContain("Human gate (from the event log)");
    expect(text).toContain("(g) Resolution outcomes:");
    expect(text).toContain("(h) Recommendation agreement: n/a (0 instrumented decisions)");
    expect(text).toContain("(i) Menu coverage: n/a (0 resolves in the instrumented era); pre-instrumentation: 0 events");
    expect(text).toContain("(j) Active review latency: n/a (0 answered sittings)");
  });

  test("renders agreement slices and coverage counts", () => {
    const events = [
      resolved("n1", "s1", at(0), { menu: MENU, accepted_body_len: 1, accepted_anchors_n: 1 }),
      event("staging_listed", "s1", at(1), { count: 1 }),
      event("session_end", "s1", at(2)),
    ];

    const text = formatGateAudit(computeGateAudit(events));

    expect(text).toContain("(h) Recommendation agreement: 1/1 overall [curation rec@2/4: 1/1]");
    expect(text).toContain("(i) Menu coverage: 1/1 resolves carry a menu; pre-instrumentation: 0 events");
    expect(text).toContain("silence episodes 1");
  });
});
