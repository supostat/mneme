import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { EventWriter, readEvents } from "../events";
import type { EventInput, StoredEvent } from "../events";
import { appendSessionStart, createSessionEndHandler } from "../mcp-server";
import { dedupPayload } from "../staging-resolve";
import { HARVEST_SOURCE } from "../workflow/harvest-artifacts";
import { defaultIsProcessAlive, liveSessionIds, sessionFacts } from "./diary-session-facts";

// A session's memory gaps and their openness, and which sessions are still running, read off a log
// several sessions append to. The session boundary is the session_id stamped by each writer.

const SESSION = "s-current";
const OTHER_SESSION = "s-other";

interface SharedLog {
  writer(sessionId: string): EventWriter;
  events(): StoredEvent[];
}

function sharedLog(): SharedLog {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-diary-session-"));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 30, 10, 0, tick++));
  const writers = new Map<string, EventWriter>();
  return {
    writer(sessionId) {
      const existing = writers.get(sessionId);
      if (existing !== undefined) return existing;
      const created = new EventWriter(eventsDir, { sessionId, mnemeVersion: "0.1.0", clock });
      writers.set(sessionId, created);
      return created;
    },
    events: () => readEvents(eventsDir),
  };
}

function recalled(query: string, gap: boolean, origin: "tool-call" | "workflow-step" = "tool-call"): EventInput {
  return {
    type: "recall",
    query,
    budget: 2000,
    returned_ids: [],
    degraded: false,
    origin,
    mode: "fused",
    corpus_size: 3,
    timings: { embed_ms: 0, fts_ms: 0, fusion_ms: 0 },
    candidates: [],
    domains: [],
    sections: [],
    gap,
  };
}

function remembered(noteId: string, source: string = "mcp", outcome: "add" | "noop" = "add"): EventInput {
  return {
    type: "remember",
    note_id: noteId,
    note_type: "decision",
    body_len: 12,
    anchors_n: 1,
    tags_n: 0,
    tags: [],
    source,
    dedup: dedupPayload(outcome, null, null, false, defaultConfig().dedup),
  };
}

describe("sessionFacts", () => {
  test("counts the session's manual recalls, its gaps and its notes, and nothing of other sessions", () => {
    const log = sharedLog();
    log.writer(SESSION).append(recalled("how is the index rebuilt", false));
    log.writer(SESSION).append(recalled("billing retry policy", true));
    log.writer(OTHER_SESSION).append(recalled("someone else's question", true));
    log.writer(OTHER_SESSION).append(remembered("n-other"));
    log.writer(SESSION).append(remembered("n1"));

    const facts = sessionFacts(log.events(), SESSION);

    expect(facts.sessionId).toBe(SESSION);
    expect(facts.recalls).toBe(2);
    expect(facts.notes).toBe(1);
    expect(facts.gaps.map((gap) => gap.query)).toEqual(["billing retry policy"]);
  });

  test("a gap before the session's last note is closed, a gap after it is open", () => {
    const log = sharedLog();
    log.writer(SESSION).append(recalled("first question", true));
    log.writer(SESSION).append(remembered("n1"));
    log.writer(SESSION).append(recalled("second question", true));
    log.writer(SESSION).append(recalled("third question", true));

    const gaps = sessionFacts(log.events(), SESSION).gaps;

    expect(gaps.map((gap) => [gap.query, gap.open])).toEqual([
      ["first question", false],
      ["second question", true],
      ["third question", true],
    ]);
    expect(gaps[0]!.ts).toBe("2026-10-30T10:00:00.000Z");
  });

  test("with no note at all every gap is open", () => {
    const log = sharedLog();
    log.writer(SESSION).append(recalled("only question", true));

    expect(sessionFacts(log.events(), SESSION).gaps.map((gap) => gap.open)).toEqual([true]);
  });

  test("a dedup noop, a harvest's note and another session's note close no gap", () => {
    const log = sharedLog();
    log.writer(SESSION).append(recalled("open question", true));
    log.writer(SESSION).append(remembered("n-noop", "mcp", "noop"));
    log.writer(SESSION).append(remembered("n-harvest", HARVEST_SOURCE));
    log.writer(OTHER_SESSION).append(remembered("n-other"));

    const facts = sessionFacts(log.events(), SESSION);

    expect(facts.notes).toBe(0);
    expect(facts.gaps.map((gap) => gap.open)).toEqual([true]);
  });

  test("the engine's own phase recalls are not the session's questions", () => {
    const log = sharedLog();
    log.writer(SESSION).append(recalled("work on phase-one", true, "workflow-step"));

    const facts = sessionFacts(log.events(), SESSION);

    expect(facts.recalls).toBe(0);
    expect(facts.gaps).toEqual([]);
  });

  // Tolerance fixture: a recall stamped before v21 has no gap key — it is a recall, not a gap.
  test("a pre-v21 recall without a gap key counts as a recall and never as a gap", () => {
    const log = sharedLog();
    const { gap: _omitted, ...withoutGap } = recalled("old question", true);
    log.writer(SESSION).append(withoutGap);

    const facts = sessionFacts(log.events(), SESSION);

    expect(facts.recalls).toBe(1);
    expect(facts.gaps).toEqual([]);
  });
});

describe("liveSessionIds", () => {
  const alive = () => true;

  test("a started session without an end whose process lives is live; an ended one is not", () => {
    const log = sharedLog();
    appendSessionStart(log.writer(SESSION));
    appendSessionStart(log.writer(OTHER_SESSION));
    createSessionEndHandler(log.writer(OTHER_SESSION))();

    expect(liveSessionIds(log.events(), alive)).toEqual([SESSION]);
  });

  test("a session cut off without its end is not live once its process is gone", () => {
    const log = sharedLog();
    appendSessionStart(log.writer(SESSION));
    const checked: number[] = [];

    const live = liveSessionIds(log.events(), (pid) => {
      checked.push(pid);
      return false;
    });

    expect(live).toEqual([]);
    expect(checked).toEqual([process.pid]);
  });

  // Tolerance fixture: a session_start stamped before v22 names no pid and can never be proven live.
  test("a session_start without a pid is never live and its process is never probed", () => {
    const log = sharedLog();
    log.writer(SESSION).append({ type: "session_start" });

    expect(liveSessionIds(log.events(), () => {
      throw new Error("a pid-less session must not be probed");
    })).toEqual([]);
  });

  test("several live sessions are all reported, oldest first", () => {
    const log = sharedLog();
    appendSessionStart(log.writer(OTHER_SESSION));
    appendSessionStart(log.writer(SESSION));

    expect(liveSessionIds(log.events(), alive)).toEqual([OTHER_SESSION, SESSION]);
  });
});

describe("defaultIsProcessAlive", () => {
  test("the current process is alive", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
  });

  test("a process that has exited is gone", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;

    expect(defaultIsProcessAlive(child.pid)).toBe(false);
  });

  // pid 1 belongs to the system: an unprivileged probe answers EPERM, which still means "it exists".
  test("a process the caller may not signal still counts as alive", () => {
    expect(defaultIsProcessAlive(1)).toBe(true);
  });
});
