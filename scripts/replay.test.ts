import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { SCHEMA_VERSION } from "../src/event-schema";
import { EVENT_FILE_EXTENSION, EventWriter, readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { recall } from "../src/recall";
import type { RecallDeps } from "../src/recall";
import { replayLog, canonicalDecisionVector, parseReplayArgs, hasOverrides, main } from "./replay";

// The index schema is copied verbatim from index-db.ts so the integration test can build a real,
// queryable index without git or a full rebuild.
const SCHEMA_STATEMENTS = [
  "CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, body, tokenize = 'porter unicode61')",
  "CREATE TABLE meta (id TEXT PRIMARY KEY, type TEXT NOT NULL, staleness_boost REAL NOT NULL)",
  "CREATE TABLE vec (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding BLOB NOT NULL)",
  "CREATE TABLE index_config (embedding_model TEXT NOT NULL)",
];

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index++) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const dimension = (hash >>> 0) % EMBEDDING_DIMENSION;
    vector[dimension] = vector[dimension]! + 1;
  }
  return vector;
}

function bagClient(): EmbeddingsClient {
  return { embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

interface NoteRow {
  id: string;
  body: string;
}

function buildIndex(rows: NoteRow[]): string {
  const indexPath = join(mkdtempSync(join(tmpdir(), "mneme-replay-idx-")), "index.db");
  const db = new Database(indexPath, { create: true });
  for (const statement of SCHEMA_STATEMENTS) db.run(statement);
  const insertFts = db.query("INSERT INTO fts(id, body) VALUES (?, ?)");
  const insertMeta = db.query("INSERT INTO meta(id, type, staleness_boost) VALUES (?, ?, ?)");
  const insertVec = db.query("INSERT INTO vec(id, content_hash, embedding) VALUES (?, ?, ?)");
  for (const row of rows) {
    insertFts.run(row.id, row.body);
    insertMeta.run(row.id, "pattern", 0);
    const vector = bagVector(row.body);
    insertVec.run(row.id, `hash-${row.id}`, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  }
  db.close();
  return indexPath;
}

function openRecallDeps(indexPath: string, eventsDir: string): RecallDeps {
  const clock = (): Date => new Date("2026-07-07T10:00:00.000Z");
  return {
    db: new Database(indexPath, { readonly: true }),
    embeddings: bagClient(),
    eventWriter: new EventWriter(eventsDir, { sessionId: "s-replay", mnemeVersion: "0.1.0", clock }),
    clock,
  };
}

function candidate(fields: Record<string, unknown> & { id: string }): Record<string, unknown> {
  return {
    type: null,
    fts_rank: null,
    vector_rank: null,
    cosine: null,
    rrf: 0,
    staleness_boost: 0,
    token_est: null,
    in_budget: false,
    ...fields,
  };
}

function recallEventFixture(overrides: Record<string, unknown>): StoredEvent {
  return {
    type: "recall",
    session_id: "s",
    ts: "2026-07-07T10:00:00.000Z",
    mneme_version: "0.1.0",
    schema_version: 3,
    query: "q",
    budget: 2000,
    returned_ids: [],
    degraded: false,
    mode: "fused",
    corpus_size: 0,
    timings: { embed_ms: 0, fts_ms: 0, fusion_ms: 0 },
    candidates: [],
    ...overrides,
  } as StoredEvent;
}

function bareEvent(fields: Record<string, unknown>): StoredEvent {
  return { type: "", session_id: null, ts: null, mneme_version: "0.1.0", schema_version: 3, ...fields } as StoredEvent;
}

// Three candidates whose distinct fts ranks fuse to the fixed order [c1, c2, c3], all within budget.
function orderedCandidates(): Array<Record<string, unknown>> {
  return [
    candidate({ id: "c1", fts_rank: 1, token_est: 1, in_budget: true }),
    candidate({ id: "c2", fts_rank: 2, token_est: 1, in_budget: true }),
    candidate({ id: "c3", fts_rank: 3, token_est: 1, in_budget: true }),
  ];
}

describe("replayLog integration with the real recall path", () => {
  test("a genuine recall log reproduces every logged decision exactly", async () => {
    const eventsDir = mkdtempSync(join(tmpdir(), "mneme-replay-events-"));
    const indexPath = buildIndex([
      { id: "n0", body: "widget alpha beta gamma delta epsilon zeta eta theta iota" },
      { id: "n1", body: "widget one small" },
      { id: "n2", body: "widget two small" },
    ]);
    const deps = openRecallDeps(indexPath, eventsDir);
    // Budget 10 admits the two small notes but skips the large one, so in_budget is mixed.
    await recall(deps, "widget", 10);
    deps.db.close();

    const report = replayLog(readEvents(eventsDir), {});

    expect(report.replays.length).toBe(1);
    expect(report.skippedPreCandidates).toBe(0);
    expect(report.replays.every((replay) => replay.identical)).toBe(true);

    // The fixture must stay genuinely mixed: at least one admitted and one skipped note, or the
    // reproduction could pass vacuously over an all-in or all-out vector.
    const decisionLines = report.replays[0]!.loggedVector.split("\n");
    expect(decisionLines.some((line) => line.endsWith(" 1"))).toBe(true);
    expect(decisionLines.some((line) => line.endsWith(" 0"))).toBe(true);
  });
});

describe("replayLog verification", () => {
  test("a faithful candidate list verifies", () => {
    const event = recallEventFixture({ candidates: orderedCandidates(), budget: 100, corpus_size: 3 });
    expect(replayLog([event], {}).replays[0]!.identical).toBe(true);
  });

  test("swapping two logged candidates breaks verification", () => {
    const base = orderedCandidates();
    const tampered = recallEventFixture({ candidates: [base[1]!, base[0]!, base[2]!], budget: 100, corpus_size: 3 });
    expect(replayLog([tampered], {}).replays[0]!.identical).toBe(false);
  });

  test("a redacted or absent query still verifies (replay never reads the query)", () => {
    const redacted = recallEventFixture({ candidates: orderedCandidates(), budget: 100, corpus_size: 3, query: "[redacted]" });
    expect(replayLog([redacted], {}).replays[0]!.identical).toBe(true);

    const { query: _omitted, ...withoutQuery } = recallEventFixture({
      candidates: orderedCandidates(),
      budget: 100,
      corpus_size: 3,
    });
    expect(replayLog([withoutQuery as StoredEvent], {}).replays[0]!.identical).toBe(true);
  });
});

describe("replayLog alternatives", () => {
  // A: fts_rank 1, staleness -0.5, token_est 5. B: fts_rank 2, staleness 0, token_est 5. Budget 5.
  // Default fusion sinks A below B, so the logged decision is [B in, A out].
  function abEvent(): StoredEvent {
    return recallEventFixture({
      candidates: [
        candidate({ id: "B", fts_rank: 2, staleness_boost: 0, token_est: 5, in_budget: true }),
        candidate({ id: "A", fts_rank: 1, staleness_boost: -0.5, token_est: 5, in_budget: false }),
      ],
      budget: 5,
      corpus_size: 2,
    });
  }

  test("the AB fixture reproduces under default params", () => {
    expect(replayLog([abEvent()], {}).replays[0]!.identical).toBe(true);
  });

  test("zeroing the staleness weight lifts A in and drops B out", () => {
    const replay = replayLog([abEvent()], { stalenessWeight: 0 }).replays[0]!;

    expect(replay.entered).toEqual(["A"]);
    expect(replay.left).toEqual(["B"]);
    expect(replay.orderChanged).toBe(true);
  });

  test("a smaller budget drops the logged in-budget note", () => {
    const replay = replayLog([abEvent()], { budget: 4 }).replays[0]!;

    expect(replay.entered).toEqual([]);
    expect(replay.left).toEqual(["B"]);
  });
});

describe("replayLog window limiting", () => {
  function windowCandidates(count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, index) =>
      candidate({ id: `w${String(index).padStart(2, "0")}`, fts_rank: index + 1, token_est: 1, in_budget: true }),
    );
  }

  test("a full window over a larger corpus is flagged window-limited", () => {
    const flagged = recallEventFixture({ candidates: windowCandidates(20), budget: 1000, corpus_size: 25 });
    expect(replayLog([flagged], {}).replays[0]!.windowLimited).toBe(true);
  });

  test("a full window whose corpus equals the window is not flagged", () => {
    const exact = recallEventFixture({ candidates: windowCandidates(20), budget: 1000, corpus_size: 20 });
    expect(replayLog([exact], {}).replays[0]!.windowLimited).toBe(false);
  });

  test("a partial window under a larger corpus is not flagged", () => {
    // The corpus exceeds the window, but only 5 candidates were logged, so the list was not truncated
    // at the window boundary and nothing beyond it is unknown.
    const partial = recallEventFixture({ candidates: windowCandidates(5), budget: 1000, corpus_size: 25 });
    expect(replayLog([partial], {}).replays[0]!.windowLimited).toBe(false);
  });
});

describe("replayLog schema handling", () => {
  test("a schema_version ahead of support anywhere refuses the whole log, naming both versions", () => {
    const events = [recallEventFixture({ candidates: orderedCandidates(), budget: 100 }), bareEvent({ type: "rebuild", schema_version: SCHEMA_VERSION + 1 })];

    expect(() => replayLog(events, {})).toThrow(`schema_version ${SCHEMA_VERSION + 1}`);
    expect(() => replayLog(events, {})).toThrow(`version ${SCHEMA_VERSION}`);
  });

  test("a pre-candidate recall event is skipped, not verified", () => {
    const v2 = bareEvent({ type: "recall", schema_version: 2, query: "q", budget: 2000, returned_ids: ["n1"], degraded: false });

    const report = replayLog([v2], {});

    expect(report.skippedPreCandidates).toBe(1);
    expect(report.replays.length).toBe(0);
  });

  test("a malformed candidate field type throws with the event timestamp", () => {
    const malformed = candidate({ id: "x", fts_rank: 1, token_est: 1, in_budget: true });
    malformed.fts_rank = "1";
    const event = recallEventFixture({ candidates: [malformed], ts: "2026-07-07T12:34:56.000Z" });

    expect(() => replayLog([event], {})).toThrow("fts_rank must be a number");
    expect(() => replayLog([event], {})).toThrow("2026-07-07T12:34:56.000Z");
  });
});

describe("canonicalDecisionVector", () => {
  test("serializes ranked pairs as one <id> <1|0> line each", () => {
    expect(
      canonicalDecisionVector([
        { id: "a", inBudget: true },
        { id: "b", inBudget: false },
      ]),
    ).toBe("a 1\nb 0");
  });
});

describe("parseReplayArgs", () => {
  test("parses the events dir and numeric flags including an explicit zero", () => {
    const args = parseReplayArgs(["/events", "--budget", "500", "--staleness-weight", "0"]);

    expect(args.eventsDir).toBe("/events");
    expect(args.overrides).toEqual({ budget: 500, stalenessWeight: 0 });
    expect(hasOverrides(args.overrides)).toBe(true);
  });

  test("every flag maps to its own override key with a distinct value", () => {
    const args = parseReplayArgs([
      "/events",
      "--budget", "100",
      "--rrf-k", "60",
      "--fts-weight", "1.5",
      "--vector-weight", "2.5",
      "--staleness-weight", "3.5",
    ]);

    expect(args.overrides).toEqual({
      budget: 100,
      rrfK: 60,
      ftsWeight: 1.5,
      vectorWeight: 2.5,
      stalenessWeight: 3.5,
    });
  });

  test("no flags selects verification mode", () => {
    const args = parseReplayArgs(["/events"]);

    expect(args.overrides).toEqual({});
    expect(hasOverrides(args.overrides)).toBe(false);
  });

  test("an unknown flag is a usage error", () => {
    expect(() => parseReplayArgs(["/events", "--nope", "1"])).toThrow("unknown flag: --nope");
  });

  test("a missing events dir is a usage error", () => {
    expect(() => parseReplayArgs(["--budget", "5"])).toThrow("missing <events-dir>");
  });

  test("a flag without a value is a usage error", () => {
    expect(() => parseReplayArgs(["/events", "--budget"])).toThrow("requires a value");
  });

  test("a non-finite flag value is a usage error", () => {
    expect(() => parseReplayArgs(["/events", "--budget", "abc"])).toThrow("needs a finite number");
  });
});

describe("hasOverrides distinguishes presence from truthiness", () => {
  test("an explicit staleness weight of zero selects alternative mode", () => {
    expect(hasOverrides({ stalenessWeight: 0 })).toBe(true);

    const args = parseReplayArgs(["/events", "--staleness-weight", "0"]);
    expect(args.overrides).toEqual({ stalenessWeight: 0 });
    expect(hasOverrides(args.overrides)).toBe(true);
  });

  test("an explicit budget of zero is a real override", () => {
    expect(hasOverrides({ budget: 0 })).toBe(true);
  });

  test("no overrides stays in verification mode", () => {
    expect(hasOverrides({})).toBe(false);
  });
});

// main() writes its report to stdout/stderr; swallow both so the exit-code assertions stay quiet.
function runMainSilently(argv: string[]): number {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const swallow = (): boolean => true;
  process.stdout.write = swallow as typeof process.stdout.write;
  process.stderr.write = swallow as typeof process.stderr.write;
  try {
    return main(argv);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function writeEventsDir(events: StoredEvent[]): string {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-replay-main-"));
  if (events.length > 0) {
    const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    writeFileSync(join(eventsDir, `2026-07${EVENT_FILE_EXTENSION}`), body);
  }
  return eventsDir;
}

describe("main exit codes", () => {
  test("verification over an empty replay set exits 1", () => {
    // Zero replayable recall events: report.replays.length === 0, which verification treats as a
    // failure to reproduce anything.
    expect(replayLog(readEvents(writeEventsDir([])), {}).replays.length).toBe(0);
    expect(runMainSilently([writeEventsDir([])])).toBe(1);
  });

  test("verification that reproduces every decision exits 0", () => {
    const eventsDir = writeEventsDir([
      recallEventFixture({ candidates: orderedCandidates(), budget: 100, corpus_size: 3 }),
    ]);
    expect(runMainSilently([eventsDir])).toBe(0);
  });

  test("verification with a tampered decision exits 1", () => {
    const base = orderedCandidates();
    const eventsDir = writeEventsDir([
      recallEventFixture({ candidates: [base[1]!, base[0]!, base[2]!], budget: 100, corpus_size: 3 }),
    ]);
    expect(runMainSilently([eventsDir])).toBe(1);
  });

  test("alternative mode exits 0 regardless of reproduction", () => {
    const eventsDir = writeEventsDir([
      recallEventFixture({ candidates: orderedCandidates(), budget: 100, corpus_size: 3 }),
    ]);
    expect(runMainSilently([eventsDir, "--staleness-weight", "0"])).toBe(0);
  });

  test("a usage error exits 2", () => {
    expect(runMainSilently(["/events", "--nope", "1"])).toBe(2);
  });
});
