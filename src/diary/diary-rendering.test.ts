import { describe, expect, test } from "bun:test";
import {
  BRIEF_WITH_RUN_ID_TEXT,
  clipForBrief,
  DIARY_BRIEF_NOTHING,
  MAX_BRIEF_GAPS,
  MAX_BRIEF_QUERY_CODE_POINTS,
  renderDiaryLine,
  renderRunAnswer,
  renderSessionFacts,
  RUN_ID_INVALID_TEXT,
  singleLine,
} from "./diary-rendering";
import type { RunFacts } from "./diary-run-facts";
import type { MemoryGap, SessionFacts } from "./diary-session-facts";

// The diary's texts are a contract a skill and a hook parse: the full forms line by line, the
// non-answers verbatim, and the brief line segment by segment. Free text from the log is folded onto
// one line everywhere; the brief line additionally caps and clips what a prompt hook injects.

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";

function runFacts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    runId: RUN_ID,
    branch: "main",
    status: "complete",
    startedTs: "2026-10-30T10:00:00.000Z",
    endedTs: "2026-10-30T11:00:00.000Z",
    iterationsUsed: 3,
    maxIterations: 20,
    diaryEntry: false,
    escalation: null,
    curation: { staged: 1, accepted: 1, rejected: 1, superseded: 0, uninstrumentedHarvests: 0 },
    phases: [
      {
        phaseId: "schema",
        reached: true,
        attempts: 2,
        bundleGap: true,
        harvest: { kind: "run", stagedByType: [{ type: "bugfix", count: 1 }, { type: "decision", count: 2 }], harvestedCount: 3, usedNotes: 1 },
        gateFailures: [
          { attempt: 1, kind: "executable", criterion: "unit tests pass", reason: "exit-nonzero", remarks: [] },
          { attempt: 1, kind: "agent-judged", criterion: "review approves", reason: "fail votes 1/2", remarks: ["the noop\npath is untested"] },
        ],
      },
      {
        phaseId: "facts",
        reached: true,
        attempts: 1,
        bundleGap: null,
        harvest: { kind: "run", stagedByType: null, harvestedCount: 2, usedNotes: null },
        gateFailures: [],
      },
      { phaseId: "tool", reached: true, attempts: 1, bundleGap: false, harvest: { kind: "not-run" }, gateFailures: [] },
      { phaseId: "cli", reached: false, attempts: 0, bundleGap: null, harvest: { kind: "not-run" }, gateFailures: [] },
    ],
    ...overrides,
  };
}

function gap(query: string, open: boolean, ts: string | null = "2026-10-30T10:05:00.000Z"): MemoryGap {
  return { ts, query, open };
}

function session(gaps: MemoryGap[], overrides: Partial<SessionFacts> = {}): SessionFacts {
  return { sessionId: "s-current", recalls: 4, notes: 1, gaps, ...overrides };
}

describe("renderRunAnswer", () => {
  test("renders the full run form line by line", () => {
    expect(renderRunAnswer({ kind: "facts", facts: runFacts() }).split("\n")).toEqual([
      `Diary facts for run ${RUN_ID} on branch "main". Nothing was written: no event, no file, no stale mark.`,
      "status complete · started 2026-10-30T10:00:00.000Z · ended 2026-10-30T11:00:00.000Z · iterations 3/20",
      "diary entry: none",
      "curation: staged 1 · accepted 1 · rejected 1 · superseded 0",
      "phase schema: attempts 2 · bundle gap yes · harvest bugfix 1, decision 2 · used notes 1",
      "  gate fail · attempt 1 · executable · unit tests pass · exit-nonzero",
      "  gate fail · attempt 1 · agent-judged · review approves · fail votes 1/2",
      "  remark: the noop path is untested",
      "phase facts: attempts 1 · bundle gap not instrumented · harvest 2 staged, kinds not instrumented · used notes not instrumented",
      "phase tool: attempts 1 · bundle gap no · harvest not run · used notes not run",
      "phase cli: not reached",
    ]);
  });

  test("adds the escalation and the uninstrumented-harvest lines only when there is something to say", () => {
    const rendered = renderRunAnswer({
      kind: "facts",
      facts: runFacts({
        status: "escalated",
        diaryEntry: true,
        endedTs: null,
        escalation: { phaseId: "schema", stepId: "implement", reason: "retry_budget_exhausted" },
        curation: { staged: 0, accepted: 0, rejected: 0, superseded: 0, uninstrumentedHarvests: 2 },
        phases: [],
      }),
    });

    expect(rendered.split("\n").slice(1)).toEqual([
      "status escalated · started 2026-10-30T10:00:00.000Z · ended unknown · iterations 3/20",
      "diary entry: present",
      "escalation: schema/implement — retry_budget_exhausted",
      "curation: staged 0 · accepted 0 · rejected 0 · superseded 0",
      "curation: 2 harvest(s) before schema v22 not counted",
    ]);
  });

  test("an empty harvest reads none", () => {
    const rendered = renderRunAnswer({
      kind: "facts",
      facts: runFacts({
        phases: [{ phaseId: "schema", reached: true, attempts: 1, bundleGap: false, harvest: { kind: "run", stagedByType: [], harvestedCount: 0, usedNotes: 0 }, gateFailures: [] }],
      }),
    });

    expect(rendered).toContain("phase schema: attempts 1 · bundle gap no · harvest none · used notes 0");
  });

  test("renders every non-answer verbatim", () => {
    expect(renderRunAnswer({ kind: "invalid-id" })).toBe(RUN_ID_INVALID_TEXT);
    expect(RUN_ID_INVALID_TEXT).toBe("run_id is not a ULID or UUID. Nothing was written.");
    expect(renderRunAnswer({ kind: "unknown", runId: RUN_ID })).toBe(
      `No workflow run ${RUN_ID} in this corpus. Nothing was written.`,
    );
    expect(renderRunAnswer({ kind: "unreadable", runId: RUN_ID, problem: "duplicate workflow_run_started for one run_id" })).toBe(
      `Run ${RUN_ID} cannot be read from the log: duplicate workflow_run_started for one run_id. Nothing was written.`,
    );
    expect(renderRunAnswer({ kind: "running", runId: RUN_ID, branch: "feature" })).toBe(
      `Run ${RUN_ID} is still running on branch "feature": diary facts describe a finished run. Nothing was written.`,
    );
    expect(BRIEF_WITH_RUN_ID_TEXT).toBe("brief describes the session only: pass brief or run_id, not both. Nothing was written.");
  });
});

describe("renderSessionFacts", () => {
  const branch = { kind: "branch" as const, branch: "main", lastTerminal: { runId: RUN_ID, status: "complete" as const, diaryEntry: false } };

  test("renders the counters, every gap oldest first with its openness, and the branch's last run", () => {
    const rendered = renderSessionFacts(
      session([gap("first question", false), gap("second\tquestion", true, null)]),
      branch,
    );

    expect(rendered.split("\n")).toEqual([
      "Diary facts for session s-current. Nothing was written: no event, no file, no stale mark.",
      "recalls 4 · memory gaps 2 · notes 1",
      "memory gaps, oldest first:",
      '- 2026-10-30T10:05:00.000Z "first question"',
      '- unknown "second question" (open)',
      `last terminal run on branch "main": ${RUN_ID} [complete] without a diary entry`,
    ]);
  });

  test("names every shape of the branch line and an empty gap list", () => {
    const withEntry = { ...branch, lastTerminal: { ...branch.lastTerminal, diaryEntry: true } };

    expect(renderSessionFacts(session([]), withEntry).split("\n").slice(2)).toEqual([
      "memory gaps: none",
      `last terminal run on branch "main": ${RUN_ID} [complete] has a diary entry`,
    ]);
    expect(renderSessionFacts(session([]), { kind: "branch", branch: "main", lastTerminal: null })).toEndWith(
      'no terminal run on branch "main"',
    );
    expect(renderSessionFacts(session([]), { kind: "detached" })).toEndWith(
      "HEAD is detached: no branch to look up a terminal run on.",
    );
    expect(renderSessionFacts(session([]), { kind: "git-error" })).toEndWith(
      "git failed to resolve the current branch: no terminal run to look up.",
    );
  });
});

describe("renderDiaryLine", () => {
  const undiaried = { runId: RUN_ID, status: "complete" as const, diaryEntry: false };

  test("is null when no segment has anything to say", () => {
    expect(renderDiaryLine(null, { kind: "no-live-session" })).toBeNull();
    expect(renderDiaryLine({ ...undiaried, diaryEntry: true }, { kind: "session", facts: session([gap("closed", false)]) })).toBeNull();
    expect(DIARY_BRIEF_NOTHING).toBe("diary: nothing to note");
  });

  test("joins the run segment and the open gaps segment", () => {
    const line = renderDiaryLine(undiaried, {
      kind: "session",
      facts: session([gap("closed", false), gap("q1", true), gap("q2", true)]),
    });

    expect(line).toBe(`diary: run ${RUN_ID} complete without a diary entry · memory gaps since the last note: "q1", "q2"`);
  });

  test("carries either segment alone", () => {
    expect(renderDiaryLine(undiaried, { kind: "no-live-session" })).toBe(`diary: run ${RUN_ID} complete without a diary entry`);
    expect(renderDiaryLine(null, { kind: "session", facts: session([gap("q1", true)]) })).toBe(
      'diary: memory gaps since the last note: "q1"',
    );
  });

  test("shows the newest open gaps only, and counts the earlier ones", () => {
    const gaps = Array.from({ length: MAX_BRIEF_GAPS + 2 }, (_, index) => gap(`q${index + 1}`, true));

    expect(renderDiaryLine(null, { kind: "session", facts: session(gaps) })).toBe(
      'diary: memory gaps since the last note: "q3", "q4", "q5", "q6", "q7" (+2 earlier)',
    );
  });

  test("names the degradation when several live sessions share the corpus", () => {
    expect(renderDiaryLine(undiaried, { kind: "shared", liveSessions: 2 })).toBe(
      `diary: run ${RUN_ID} complete without a diary entry · memory gaps: n/a — 2 live sessions share this corpus`,
    );
  });

  test("folds a query onto one line, clips it to the code-point limit, and leaves quotes and backslashes raw", () => {
    const long = "é".repeat(MAX_BRIEF_QUERY_CODE_POINTS + 10);
    const line = renderDiaryLine(null, {
      kind: "session",
      facts: session([gap('say "hi"\\\nthen\u2028go', true), gap(long, true)]),
    });

    expect(line).toBe(
      `diary: memory gaps since the last note: "say "hi"\\ then go", "${"é".repeat(MAX_BRIEF_QUERY_CODE_POINTS - 1)}…"`,
    );
  });
});

describe("singleLine and clipForBrief", () => {
  test("every control character and line separator becomes one space, ends trimmed", () => {
    expect(singleLine("\ta\r\nb\u0085c\u2028d\u2029e\u0000f  g ")).toBe("a b c d e f g");
  });

  test("clipping counts code points: an astral character is never split", () => {
    const astral = "😀".repeat(MAX_BRIEF_QUERY_CODE_POINTS);
    const atLimit = clipForBrief(astral);
    const overLimit = clipForBrief(`${astral}x`);

    expect(atLimit).toBe(astral);
    expect([...overLimit].length).toBe(MAX_BRIEF_QUERY_CODE_POINTS);
    expect(overLimit.endsWith("😀…")).toBe(true);
  });
});
