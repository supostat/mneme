import { test, expect, describe } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { computeStats, formatStats } from "./stats";

function storedEvent(fields: Record<string, unknown>): StoredEvent {
  return {
    type: "",
    session_id: null,
    ts: null,
    mneme_version: "0.1.0",
    schema_version: 1,
    ...fields,
  } as StoredEvent;
}

function acceptedEvent(noteId: string, sessionId: string | null, ts: string | null): StoredEvent {
  return storedEvent({ type: "note_accepted", note_id: noteId, commit: "abc1234", session_id: sessionId, ts });
}

function recallEvent(
  sessionId: string | null,
  ts: string | null,
  returnedIds: string[],
  degraded = false,
  origin?: string,
): StoredEvent {
  return storedEvent({
    type: "recall",
    query: "q",
    budget: 2000,
    returned_ids: returnedIds,
    degraded,
    session_id: sessionId,
    ts,
    ...(origin === undefined ? {} : { origin }),
  });
}

function stagedEvent(
  noteId: string,
  noteType: string,
  sessionId: string | null = null,
  ts: string | null = null,
): StoredEvent {
  return storedEvent({ type: "note_staged", note_id: noteId, note_type: noteType, session_id: sessionId, ts });
}

function supersededEvent(noteId: string, supersededId: string): StoredEvent {
  return storedEvent({ type: "note_superseded", note_id: noteId, superseded_id: supersededId, commit: "def5678", suggested: false });
}

function dedupedEvent(noteId: string, existingId: string): StoredEvent {
  return storedEvent({ type: "note_deduped", note_id: noteId, existing_id: existingId, similarity: 0.99 });
}

const V2_THRESHOLDS = { supersede_threshold: 0.85, noop_threshold: 0.97 };

function rememberEvent(
  noteId: string,
  noteType: string,
  sessionId: string | null = null,
  ts: string | null = null,
): StoredEvent {
  return storedEvent({
    type: "remember",
    note_id: noteId,
    note_type: noteType,
    body_len: 12,
    anchors_n: 1,
    source: "mcp",
    dedup: { outcome: "add", nearest_id: null, similarity: null, ...V2_THRESHOLDS, degraded: false },
    session_id: sessionId,
    ts,
  });
}

function rememberNoopEvent(noteId: string, nearestId: string): StoredEvent {
  return storedEvent({
    type: "remember",
    note_id: noteId,
    note_type: "pattern",
    body_len: 12,
    anchors_n: 1,
    source: "mcp",
    dedup: { outcome: "noop", nearest_id: nearestId, similarity: 0.99, ...V2_THRESHOLDS, degraded: false },
  });
}

function resolveEvent(
  noteId: string,
  decision: "accept" | "reject" | "supersede",
  supersededId: string | null = null,
): StoredEvent {
  return storedEvent({
    type: "staging_resolve",
    note_id: noteId,
    decision,
    staged_to_resolved_ms: 0,
    commit: decision === "reject" ? null : "abc1234",
    superseded_id: supersededId,
    suggested: decision === "supersede" ? false : null,
  });
}

describe("computeStats accepted population is historical", () => {
  test("denominators are |accepted| and do NOT shrink when a note is superseded", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern", "sessionA", "2026-07-06T09:59:00.000Z"),
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      acceptedEvent("n2", "sessionA", "2026-07-06T10:00:01.000Z"),
      acceptedEvent("n3", "sessionA", "2026-07-06T10:00:02.000Z"),
      supersededEvent("nX", "n2"),
      recallEvent("sessionB", "2026-07-06T11:00:00.000Z", ["n1"]),
    ]);

    expect(summary.acceptedNoteCount).toBe(3);
    expect(summary.liveNoteCount).toBe(2);
    expect(summary.crossSessionReuse.denominator).toBe(3);
    expect(summary.crossSessionReuse.numerator).toBe(1);
    expect(summary.neverRetrieved.denominator).toBe(3);
  });

  test("a note reused-then-superseded still counts in cross-session reuse", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern", "sessionA", "2026-07-06T09:59:00.000Z"),
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      recallEvent("sessionB", "2026-07-06T11:00:00.000Z", ["n1"]),
      supersededEvent("nX", "n1"),
    ]);

    expect(summary.crossSessionReuse.numerator).toBe(1);
    expect(summary.crossSessionReuse.denominator).toBe(1);
    expect(summary.liveNoteCount).toBe(0);
  });

  test("a note staged in one session but accepted and recalled in a later session counts", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern", "sessionA", "2026-07-06T10:00:00.000Z"),
      acceptedEvent("n1", "sessionB", "2026-07-06T11:00:00.000Z"),
      recallEvent("sessionB", "2026-07-06T12:00:00.000Z", ["n1"]),
    ]);

    expect(summary.crossSessionReuse.numerator).toBe(1);
    expect(summary.crossSessionReuse.denominator).toBe(1);
  });

  test("an accepted note with no staging anchor cannot be ordered and is not counted", () => {
    const summary = computeStats([
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      recallEvent("sessionB", "2026-07-06T11:00:00.000Z", ["n1"]),
    ]);

    expect(summary.acceptedNoteCount).toBe(1);
    expect(summary.crossSessionReuse.numerator).toBe(0);
  });
});

describe("computeStats never-retrieved", () => {
  test("a superseded, never-retrieved note is in the numerator AND flagged as superseded", () => {
    const summary = computeStats([
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      supersededEvent("nX", "n1"),
    ]);

    expect(summary.neverRetrieved.numerator).toBe(1);
    expect(summary.neverRetrieved.denominator).toBe(1);
    expect(summary.neverRetrievedSupersededCount).toBe(1);
  });

  test("a retrieved note is excluded from the never-retrieved numerator", () => {
    const summary = computeStats([
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      acceptedEvent("n2", "sessionA", "2026-07-06T10:00:01.000Z"),
      recallEvent("sessionA", "2026-07-06T10:05:00.000Z", ["n1"]),
    ]);

    expect(summary.neverRetrieved.numerator).toBe(1);
    expect(summary.neverRetrieved.denominator).toBe(2);
    expect(summary.neverRetrievedSupersededCount).toBe(0);
  });
});

describe("computeStats corpus size by type is live-only", () => {
  test("superseded notes are excluded and an unmatched note lands in untyped", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern"),
      stagedEvent("n2", "decision"),
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      acceptedEvent("n2", "sessionA", "2026-07-06T10:00:01.000Z"),
      acceptedEvent("n3", "sessionA", "2026-07-06T10:00:02.000Z"),
      supersededEvent("nX", "n2"),
    ]);

    expect(summary.liveNoteCount).toBe(2);
    expect(summary.corpusSizeByType.byType).toEqual({ pattern: 1 });
    expect(summary.corpusSizeByType.untyped).toBe(1);
  });
});

describe("computeStats noop confirmations and degradation", () => {
  test("noop confirmations equals the note_deduped count", () => {
    const summary = computeStats([
      dedupedEvent("n1", "n0"),
      dedupedEvent("n2", "n0"),
      acceptedEvent("n3", "sessionA", "2026-07-06T10:00:00.000Z"),
    ]);

    expect(summary.noopConfirmations).toBe(2);
  });

  test("noop distinct note count is the number of distinct re-confirmed existing notes", () => {
    const summary = computeStats([
      dedupedEvent("n1", "n0"),
      dedupedEvent("n2", "n0"),
      dedupedEvent("n3", "n9"),
    ]);

    expect(summary.noopConfirmations).toBe(3);
    expect(summary.noopDistinctNoteCount).toBe(2);
  });

  test("degradation frequency counts degraded recalls over all recalls", () => {
    const summary = computeStats([
      recallEvent("sessionA", "2026-07-06T10:00:00.000Z", [], true),
      recallEvent("sessionA", "2026-07-06T10:00:01.000Z", [], false),
      recallEvent("sessionA", "2026-07-06T10:00:02.000Z", [], false),
    ]);

    expect(summary.degradationFrequency.numerator).toBe(1);
    expect(summary.degradationFrequency.denominator).toBe(3);
    expect(summary.degradationFrequency.ratio).toBeCloseTo(1 / 3);
  });
});

describe("computeStats ratio is null iff the denominator is zero", () => {
  test("an empty log yields null ratios", () => {
    const summary = computeStats([]);

    expect(summary.crossSessionReuse.ratio).toBeNull();
    expect(summary.neverRetrieved.ratio).toBeNull();
    expect(summary.degradationFrequency.ratio).toBeNull();
    expect(summary.acceptedNoteCount).toBe(0);
  });

  test("a zero numerator over a positive denominator is 0, not null", () => {
    const summary = computeStats([
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
    ]);

    expect(summary.crossSessionReuse.ratio).toBe(0);
    expect(summary.crossSessionReuse.denominator).toBe(1);
  });
});

describe("computeStats cross-session ordering guards", () => {
  test("a null-ts staging anchor never counts as cross-session reused", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern", "sessionA", null),
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      recallEvent("sessionB", "2026-07-06T11:00:00.000Z", ["n1"]),
    ]);

    expect(summary.acceptedNoteCount).toBe(1);
    expect(summary.crossSessionReuse.numerator).toBe(0);
  });

  test("same-staging-session, earlier, and null-ts recalls do not count as cross-session reuse", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern", "sessionA", "2026-07-06T10:00:00.000Z"),
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      recallEvent("sessionA", "2026-07-06T12:00:00.000Z", ["n1"]),
      recallEvent("sessionB", "2026-07-06T09:00:00.000Z", ["n1"]),
      recallEvent("sessionC", null, ["n1"]),
    ]);

    expect(summary.crossSessionReuse.numerator).toBe(0);
  });
});

describe("formatStats renders degenerate ratios honestly", () => {
  test("an empty log renders n/a for every ratio", () => {
    const rendered = formatStats(computeStats([]));

    expect(rendered).toContain("Accepted notes (historical): 0");
    expect(rendered).toContain("Cross-session reuse: n/a (0 accepted notes)");
    expect(rendered).toContain("Never retrieved: n/a (0 accepted notes)");
    expect(rendered).toContain("Recall degradation: n/a (0 recall events)");
    expect(rendered).toContain("NOOP confirmations: 0 (0 distinct notes) (write-path re-encounters of existing notes)");
  });

  test("the NOOP line reports the event count and the distinct re-confirmed note count", () => {
    const rendered = formatStats(computeStats([dedupedEvent("n1", "n0"), dedupedEvent("n2", "n0")]));

    expect(rendered).toContain("NOOP confirmations: 2 (1 distinct notes) (write-path re-encounters of existing notes)");
  });

  test("the never-retrieved line shows the superseded breakdown", () => {
    const rendered = formatStats(
      computeStats([
        acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
        supersededEvent("nX", "n1"),
      ]),
    );

    expect(rendered).toContain("Never retrieved: 1/1 (100.0%) (of which 1 superseded)");
  });
});

describe("computeStats reads the v2 dialect", () => {
  test("remember + staging_resolve reproduce accepted, live, cross-session and corpus-size counts", () => {
    const summary = computeStats([
      rememberEvent("n1", "pattern", "sessionA", "2026-07-06T09:59:00.000Z"),
      resolveEvent("n1", "accept"),
      rememberEvent("n2", "decision", "sessionA", "2026-07-06T09:59:30.000Z"),
      resolveEvent("n2", "accept"),
      resolveEvent("nX", "supersede", "n2"),
      recallEvent("sessionB", "2026-07-06T11:00:00.000Z", ["n1"]),
    ]);

    expect(summary.acceptedNoteCount).toBe(3);
    expect(summary.liveNoteCount).toBe(2);
    expect(summary.crossSessionReuse.numerator).toBe(1);
    expect(summary.crossSessionReuse.denominator).toBe(3);
    expect(summary.corpusSizeByType.byType).toEqual({ pattern: 1 });
    expect(summary.corpusSizeByType.untyped).toBe(1);
  });

  test("a v2 remember noop counts with its nearest_id as the re-confirmed note", () => {
    const summary = computeStats([rememberNoopEvent("n1", "n0"), rememberNoopEvent("n2", "n0")]);

    expect(summary.noopConfirmations).toBe(2);
    expect(summary.noopDistinctNoteCount).toBe(1);
  });
});

describe("computeStats reads a mixed v1-and-v2 log", () => {
  test("both dialects contribute to accepted, cross-session, corpus-size and noop counts", () => {
    const summary = computeStats([
      stagedEvent("n1", "pattern", "sessionA", "2026-07-06T09:59:00.000Z"),
      acceptedEvent("n1", "sessionA", "2026-07-06T10:00:00.000Z"),
      rememberEvent("n2", "decision", "sessionA", "2026-07-06T09:59:30.000Z"),
      resolveEvent("n2", "accept"),
      dedupedEvent("n3", "n1"),
      rememberNoopEvent("n4", "n2"),
      recallEvent("sessionB", "2026-07-06T11:00:00.000Z", ["n1", "n2"]),
    ]);

    expect(summary.acceptedNoteCount).toBe(2);
    expect(summary.crossSessionReuse.numerator).toBe(2);
    expect(summary.crossSessionReuse.denominator).toBe(2);
    expect(summary.corpusSizeByType.byType).toEqual({ pattern: 1, decision: 1 });
    expect(summary.noopConfirmations).toBe(2);
    expect(summary.noopDistinctNoteCount).toBe(2);
  });
});

describe("computeStats tolerates a torn real event log", () => {
  test("a malformed line does not throw and well-formed counts survive", () => {
    const eventsDir = mkdtempSync(join(tmpdir(), "mneme-stats-"));
    const writerA = new EventWriter(eventsDir, {
      sessionId: "sessionA",
      clock: () => new Date("2026-07-06T10:00:00.000Z"),
      mnemeVersion: "0.1.0",
    });
    writerA.append({ type: "note_staged", note_id: "n1", note_type: "pattern" });
    writerA.append({ type: "note_accepted", note_id: "n1", commit: "abc1234" });
    appendFileSync(join(eventsDir, "2026-07.jsonl"), "{ torn garbage line\n");
    const writerB = new EventWriter(eventsDir, {
      sessionId: "sessionB",
      clock: () => new Date("2026-07-06T11:00:00.000Z"),
      mnemeVersion: "0.1.0",
    });
    writerB.append({ type: "recall", query: "q", budget: 2000, returned_ids: ["n1"], degraded: false });

    const summary = computeStats(readEvents(eventsDir));

    expect(summary.acceptedNoteCount).toBe(1);
    expect(summary.recallEventCount).toBe(1);
    expect(summary.crossSessionReuse.numerator).toBe(1);
  });
});

describe("recall origin breakdown", () => {
  test("recall events are counted by origin, missing origin folding into unknown", () => {
    const events = [
      recallEvent("s1", "2026-07-10T10:00:00.000Z", [], false, "workflow-step"),
      recallEvent("s1", "2026-07-10T10:01:00.000Z", [], false, "workflow-step"),
      recallEvent("s1", "2026-07-10T10:02:00.000Z", [], false, "tool-call"),
      recallEvent("s1", "2026-07-10T10:03:00.000Z", [], false),
    ];

    const summary = computeStats(events);

    expect(summary.recallEventCount).toBe(4);
    expect(summary.recallByOrigin).toEqual({ "workflow-step": 2, "tool-call": 1, unknown: 1 });
  });

  test("formatStats renders the engine/manual/unknown recall split", () => {
    const summary = computeStats([
      recallEvent("s1", "2026-07-10T10:00:00.000Z", [], false, "workflow-step"),
      recallEvent("s1", "2026-07-10T10:01:00.000Z", [], false, "tool-call"),
    ]);

    expect(formatStats(summary)).toContain("Recall events: 2 (engine 1, manual 1, unknown 0)");
  });
});
