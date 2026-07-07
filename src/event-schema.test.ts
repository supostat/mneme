import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventWriter, readEvents } from "./events";
import type { EventInput, StoredEvent } from "./events";
import { eventSchema, SCHEMA_VERSION, BOOTSTRAP_TO_EXTENDED } from "./event-schema";

// Stamps a producer event through the real writer so the test validates exactly what lands on disk.
function stamp(event: EventInput): StoredEvent {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-schema-"));
  new EventWriter(eventsDir, {
    sessionId: "s-schema",
    mnemeVersion: "0.1.0",
    clock: () => new Date("2026-07-06T10:00:00.000Z"),
  }).append(event);
  return readEvents(eventsDir)[0]!;
}

const DEDUP_ADD = {
  outcome: "add",
  nearest_id: null,
  similarity: null,
  supersede_threshold: 0.85,
  noop_threshold: 0.97,
  degraded: false,
};

const FULL_CANDIDATE = {
  id: "n1",
  type: "pattern",
  fts_rank: 1,
  vector_rank: null,
  cosine: null,
  rrf: 0.016,
  staleness_boost: 0,
  token_est: 5,
  in_budget: true,
};

const LIVE_EVENTS: Record<string, EventInput> = {
  recall: {
    type: "recall",
    query: "q",
    budget: 2000,
    returned_ids: ["n1"],
    degraded: false,
    mode: "fused",
    corpus_size: 3,
    timings: { embed_ms: 1, fts_ms: 0, fusion_ms: 2 },
    candidates: [FULL_CANDIDATE],
  },
  remember: { type: "remember", note_id: "n1", note_type: "pattern", body_len: 12, anchors_n: 1, source: "mcp", dedup: DEDUP_ADD },
  staging_resolve_accept: { type: "staging_resolve", note_id: "n1", decision: "accept", staged_to_resolved_ms: 0, commit: "abc1234", superseded_id: null, suggested: null },
  staging_resolve_reject: { type: "staging_resolve", note_id: "n1", decision: "reject", staged_to_resolved_ms: null, commit: null, superseded_id: null, suggested: null },
  staging_resolve_supersede: { type: "staging_resolve", note_id: "n1", decision: "supersede", staged_to_resolved_ms: 5, commit: "abc1234", superseded_id: "n0", suggested: true },
  staging_listed: { type: "staging_listed", count: 1, liveness: [{ id: "n1", anchors: [{ path: "src/a.ts", liveness: "tracked" }] }] },
  rebuild: { type: "rebuild", duration_ms: 0, notes_n: 2, embedded_n: 2, dead_anchors_n: 1, staleness: [0, -1], ollama: { available: true, retries: 0 } },
  session_start: { type: "session_start" },
  session_end: { type: "session_end" },
  tool_error: { type: "tool_error", tool: "recall", message: "boom" },
};

describe("eventSchema validates the writer-stamped producer events", () => {
  for (const [name, event] of Object.entries(LIVE_EVENTS)) {
    test(`${name} passes safeParse`, () => {
      expect(eventSchema.safeParse(stamp(event)).success).toBe(true);
    });
  }
});

describe("event-schema constants", () => {
  test("SCHEMA_VERSION is 3", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  test("BOOTSTRAP_TO_EXTENDED maps the five schema-v1 write-path names", () => {
    expect(BOOTSTRAP_TO_EXTENDED).toEqual({
      note_staged: "remember",
      note_deduped: "remember",
      note_accepted: "staging_resolve",
      note_rejected: "staging_resolve",
      note_superseded: "staging_resolve",
    });
  });
});

describe("eventSchema rejects malformed producer events", () => {
  test("a remember missing note_type fails", () => {
    const event = stamp({ type: "remember", note_id: "n1", body_len: 12, anchors_n: 1, source: "mcp", dedup: DEDUP_ADD });
    expect(eventSchema.safeParse(event).success).toBe(false);
  });

  test("a staging_resolve with an unknown decision fails", () => {
    const event = stamp({ type: "staging_resolve", note_id: "n1", decision: "frobnicate", staged_to_resolved_ms: 0, commit: null, superseded_id: null, suggested: null });
    expect(eventSchema.safeParse(event).success).toBe(false);
  });

  test("a rebuild with a non-array staleness fails", () => {
    const event = stamp({ type: "rebuild", duration_ms: 0, notes_n: 1, embedded_n: 1, dead_anchors_n: 0, staleness: 3, ollama: { available: true, retries: 0 } });
    expect(eventSchema.safeParse(event).success).toBe(false);
  });
});

describe("eventSchema recall candidate window", () => {
  function recallWith(overrides: Partial<EventInput>): EventInput {
    return {
      type: "recall",
      query: "q",
      budget: 2000,
      returned_ids: [],
      degraded: false,
      mode: "fused",
      corpus_size: 30,
      timings: { embed_ms: 0, fts_ms: 0, fusion_ms: 0 },
      candidates: [FULL_CANDIDATE],
      ...overrides,
    };
  }

  test("a recall with one full candidate including nulls validates", () => {
    expect(eventSchema.safeParse(stamp(recallWith({}))).success).toBe(true);
  });

  test("a recall carrying twenty-one candidates fails the .max(20) bound", () => {
    const candidates = Array.from({ length: 21 }, (_, index) => ({ ...FULL_CANDIDATE, id: `n${index}` }));
    expect(eventSchema.safeParse(stamp(recallWith({ candidates }))).success).toBe(false);
  });

  test("a candidate missing in_budget fails", () => {
    const { in_budget: _omitted, ...withoutInBudget } = FULL_CANDIDATE;
    expect(eventSchema.safeParse(stamp(recallWith({ candidates: [withoutInBudget] }))).success).toBe(false);
  });

  test("an unknown recall mode fails", () => {
    expect(eventSchema.safeParse(stamp(recallWith({ mode: "hybrid" }))).success).toBe(false);
  });
});
