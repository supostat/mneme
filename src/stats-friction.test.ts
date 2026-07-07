import { test, expect, describe } from "bun:test";
import type { StoredEvent } from "./events";
import { computeFriction, formatFriction, RESOLVE_BATCH_GAP_MS } from "./stats-friction";
import type { FrictionSummary } from "./stats-friction";

function storedEvent(fields: Record<string, unknown>): StoredEvent {
  return {
    type: "",
    session_id: null,
    ts: null,
    mneme_version: "0.1.0",
    schema_version: 3,
    ...fields,
  } as StoredEvent;
}

function resolveV2(
  noteId: string,
  sessionId: string | null,
  ts: string | null,
  loggedMs: number | null,
): StoredEvent {
  return storedEvent({
    type: "staging_resolve",
    note_id: noteId,
    decision: "accept",
    staged_to_resolved_ms: loggedMs,
    commit: "abc1234",
    superseded_id: null,
    suggested: null,
    session_id: sessionId,
    ts,
  });
}

function acceptV1(noteId: string, sessionId: string | null, ts: string | null): StoredEvent {
  return storedEvent({ type: "note_accepted", note_id: noteId, commit: "abc1234", session_id: sessionId, ts });
}

function stagedV1(noteId: string, sessionId: string | null, ts: string | null): StoredEvent {
  return storedEvent({ type: "note_staged", note_id: noteId, note_type: "pattern", session_id: sessionId, ts });
}

function toolError(tool: string): StoredEvent {
  return storedEvent({ type: "tool_error", tool, message: "boom" });
}

// A timestamp exactly `offsetMs` after the base instant, so batch-gap boundaries can be pinned.
const BASE = Date.parse("2026-07-07T10:00:00.000Z");
function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

describe("computeFriction latency percentiles", () => {
  test("nearest-rank median and p90 over the logged latencies", () => {
    const summary = computeFriction([
      resolveV2("n1", "s", at(0), 30),
      resolveV2("n2", "s", at(1), 10),
      resolveV2("n3", "s", at(2), 50),
      resolveV2("n4", "s", at(3), 20),
      resolveV2("n5", "s", at(4), 40),
    ]);

    // Sorted [10,20,30,40,50]: median = index ceil(0.5*5)-1 = 2 -> 30; p90 = ceil(0.9*5)-1 = 4 -> 50.
    expect(summary.durations).toEqual({ count: 5, median: 30, p90: 50 });
  });
});

describe("computeFriction duplicate collapse (D-D)", () => {
  test("a replayed resolve with a later ts and inflated ms is counted once with the earliest", () => {
    const summary = computeFriction([
      resolveV2("n1", "s", at(0), 1000),
      resolveV2("n1", "s", at(RESOLVE_BATCH_GAP_MS), 5000),
    ]);

    expect(summary.durations).toEqual({ count: 1, median: 1000, p90: 1000 });
    expect(summary.batches).toEqual({ bySize: { 1: 1 }, batchCount: 1 });
  });
});

describe("computeFriction duplicate collapse null timestamp (D-D)", () => {
  test("a null-ts duplicate always loses to the timestamped resolve", () => {
    const summary = computeFriction([
      resolveV2("n1", "s", null, 1000),
      resolveV2("n1", "s", at(0), 5000),
    ]);

    // compareTs ranks a null ts below any real ts before compareMs is consulted, so the timestamped
    // resolve survives even though its logged latency (5000 ms) exceeds the null-ts replay's 1000 ms.
    // The survivor's real ts also lets it cluster, which the excluded null-ts loser never could.
    expect(summary.durations).toEqual({ count: 1, median: 5000, p90: 5000 });
    expect(summary.batches).toEqual({ bySize: { 1: 1 }, batchCount: 1 });
  });
});

describe("computeFriction duplicate collapse tie-breaks (D-D)", () => {
  test("with an equal ts the smaller logged latency survives the collapse", () => {
    const summary = computeFriction([
      resolveV2("n1", "s", at(0), 5000),
      resolveV2("n1", "s", at(0), 1000),
    ]);

    // Equal timestamps fall through the compareTs tier to compareMs: the smaller latency wins, so
    // the inflated 5000 ms replay is dropped and only 1000 ms feeds the percentiles.
    expect(summary.durations).toEqual({ count: 1, median: 1000, p90: 1000 });
  });

  test("with an equal ts and latency the earliest-logged resolve survives the collapse", () => {
    const summary = computeFriction([
      resolveV2("n1", "s1", at(0), 100),
      resolveV2("n1", "s2", at(0), 100),
      resolveV2("n2", "s1", at(1000), 100),
    ]);

    // A full tie (same ts, same latency) falls past compareMs to the log-order tie-break, keeping
    // the earliest. The survivor's session_id is observable through clustering: only if the order-0
    // resolve (s1) survives do n1 and n2 share session s1 within the gap and form one batch of two.
    expect(summary.batches).toEqual({ bySize: { 2: 1 }, batchCount: 1 });
  });
});

describe("computeFriction batch gap boundary (D-B)", () => {
  test("a gap exactly at the constant stays one batch", () => {
    const summary = computeFriction([
      resolveV2("n1", "s", at(0), null),
      resolveV2("n2", "s", at(RESOLVE_BATCH_GAP_MS), null),
    ]);

    expect(summary.batches).toEqual({ bySize: { 2: 1 }, batchCount: 1 });
  });

  test("a gap one millisecond past the constant splits into two batches", () => {
    const summary = computeFriction([
      resolveV2("n1", "s", at(0), null),
      resolveV2("n2", "s", at(RESOLVE_BATCH_GAP_MS + 1), null),
    ]);

    expect(summary.batches).toEqual({ bySize: { 1: 2 }, batchCount: 2 });
  });
});

describe("computeFriction cross-dialect batches (D-C)", () => {
  test("a v1 and a v2 resolve in one session within the gap form one batch of two", () => {
    const summary = computeFriction([
      acceptV1("n1", "s", at(0)),
      resolveV2("n2", "s", at(60_000), null),
    ]);

    expect(summary.batches).toEqual({ bySize: { 2: 1 }, batchCount: 1 });
  });
});

describe("computeFriction clustering exclusions", () => {
  test("a null session resolve is excluded from batches but still timed", () => {
    const summary = computeFriction([
      resolveV2("n1", null, at(0), 100),
      resolveV2("n2", "s", at(0), 200),
    ]);

    expect(summary.durations).toEqual({ count: 2, median: 100, p90: 200 });
    expect(summary.batches).toEqual({ bySize: { 1: 1 }, batchCount: 1 });
  });

  test("a v1 resolve with no staging anchor batches but cannot be timed", () => {
    const summary = computeFriction([acceptV1("n1", "s", at(0))]);

    expect(summary.durations).toEqual({ count: 0, median: null, p90: null });
    expect(summary.batches).toEqual({ bySize: { 1: 1 }, batchCount: 1 });
  });

  test("a v1 resolve is timed from its note's earliest staging anchor", () => {
    const summary = computeFriction([
      stagedV1("n1", "s", at(0)),
      acceptV1("n1", "s", at(90_000)),
    ]);

    expect(summary.durations).toEqual({ count: 1, median: 90_000, p90: 90_000 });
  });
});

describe("computeFriction tool errors", () => {
  test("counts tool_error events by tool", () => {
    const summary = computeFriction([toolError("recall"), toolError("recall"), toolError("remember")]);

    expect(summary.toolErrors).toEqual({ recall: 2, remember: 1 });
  });

  test("a tool_error without a tool keys under the empty string and renders as (untyped)", () => {
    const summary = computeFriction([storedEvent({ type: "tool_error", message: "boom" })]);

    expect(summary.toolErrors).toEqual({ "": 1 });
    expect(formatFriction(summary)).toContain("(f) Tool errors: (untyped): 1");
  });
});

describe("computeFriction and formatFriction on an empty log", () => {
  test("an empty log yields null percentiles and no batches", () => {
    const summary = computeFriction([]);

    expect(summary.durations).toEqual({ count: 0, median: null, p90: null });
    expect(summary.batches).toEqual({ bySize: {}, batchCount: 0 });
    expect(summary.toolErrors).toEqual({});
  });

  test("formatFriction renders n/a for degenerate friction", () => {
    const rendered = formatFriction(computeFriction([]));

    expect(rendered).toContain("(d) Staged -> resolved latency: n/a (0 resolutions)");
    expect(rendered).toContain("(e) Resolution batch sizes: n/a (0 batches)");
    expect(rendered).toContain("(f) Tool errors: none");
  });
});

describe("formatFriction on a populated summary", () => {
  test("renders the latency line, the size-sorted batch histogram, and the tool-error counts", () => {
    const populated: FrictionSummary = {
      durations: { count: 5, median: 30, p90: 90 },
      batches: { bySize: { 2: 3, 10: 1 }, batchCount: 4 },
      toolErrors: { recall: 2, remember: 1 },
    };

    const rendered = formatFriction(populated);

    expect(rendered).toContain("(d) Staged -> resolved latency: median 30 ms, p90 90 ms (5 resolutions)");
    expect(rendered).toContain("(e) Resolution batch sizes: 4 batches [3×2, 1×10]");
    expect(rendered).toContain("(f) Tool errors: recall: 2, remember: 1");
  });
});
