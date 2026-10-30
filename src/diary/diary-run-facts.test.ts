import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { EventWriter, readEvents } from "../events";
import type { EventInput, StoredEvent } from "../events";
import { dedupPayload } from "../staging-resolve";
import type { GateReport } from "../workflow/gate-runner";
import type { PhaseDocument } from "../workflow/phase-document";
import { buildPhaseGraph } from "../workflow/phase-graph";
import type { RunDefinition, StepResult } from "../workflow/reducer";
import {
  runAbandonedPayload,
  runMarkedStalePayload,
  runStartedPayload,
  stepAppliedPayload,
} from "../workflow/run-payloads";
import type { StagedNoteRef, StepApplication, UsedNoteRef } from "../workflow/run-payloads";
import { DIARY_TAG, runTag } from "./diary-entries";
import { renderRunAnswer } from "./diary-rendering";
import { lastTerminalRunOf, runFacts } from "./diary-run-facts";
import type { RunFacts, RunFactsAnswer } from "./diary-run-facts";

// The facts of one finished run, folded from the run's own events as the engine's real serializers
// write them. Each phase's attempts, gate failures, bundle gap, harvest and usage declaration, and
// the fate of every note the run staged, are read off workflow_step_applied and the human's
// staging_resolve decisions — never off neighbouring log lines.

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const SECOND_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const THIRD_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const RETRIEVAL = { recallBudget: 2000, recallAnchors: {}, recallDomains: {} };

interface Log {
  append(event: EventInput): void;
  events(): StoredEvent[];
}

function createLog(): Log {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-diary-run-"));
  let tick = 0;
  const writer = new EventWriter(eventsDir, {
    sessionId: "s-diary",
    mnemeVersion: "0.1.0",
    clock: () => new Date(Date.UTC(2026, 9, 30, 10, 0, tick++)),
  });
  return { append: (event) => writer.append(event), events: () => readEvents(eventsDir) };
}

function phaseDocument(id: string, deps: string[]): PhaseDocument {
  return {
    id,
    deps,
    agentRole: "coder",
    description: `Work on ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "unit tests pass", command: "true", timeoutSeconds: null }],
    knowledge: [],
  };
}

function definition(phaseIds: string[], maxAttempts: number): RunDefinition {
  return {
    graph: buildPhaseGraph(phaseIds.map((id, index) => phaseDocument(id, index === 0 ? [] : [phaseIds[index - 1]!]))),
    steps: [{ id: "implement", maxAttempts, onFail: { action: "escalate" } }],
    maxIterations: 20,
  };
}

function started(log: Log, runId: string, branch: string, phaseIds: string[], maxAttempts = 2): void {
  log.append({ ...runStartedPayload(runId, branch, definition(phaseIds, maxAttempts), RETRIEVAL), type: "workflow_run_started" });
}

function applied(log: Log, runId: string, branch: string, application: StepApplication): void {
  log.append({ ...stepAppliedPayload(runId, branch, application), type: "workflow_step_applied" });
}

function application(result: StepResult, overrides: Partial<StepApplication> = {}): StepApplication {
  return {
    result,
    attempt: null,
    gates: null,
    harvestedCount: null,
    dedupRejected: null,
    bundleNotes: null,
    usedNotes: null,
    gap: null,
    stagedNotes: null,
    ...overrides,
  };
}

function recallOf(phaseId: string, gap: boolean): StepApplication {
  return application({ kind: "recall", phaseId }, { bundleNotes: [], gap });
}

function executionOf(phaseId: string, attempt: number, outcome: "success" | "failure", gates: GateReport): StepApplication {
  return application({ kind: "execute_step", phaseId, stepId: "implement", outcome }, { attempt, gates });
}

function harvestOf(phaseId: string, stagedNotes: StagedNoteRef[], usedNotes: UsedNoteRef[] | null): StepApplication {
  return application(
    { kind: "harvest", phaseId },
    { harvestedCount: stagedNotes.length, dedupRejected: [], usedNotes, stagedNotes },
  );
}

const GREEN_GATES: GateReport = {
  passed: true,
  criterionResults: [
    { kind: "executable", description: "unit tests pass", command: "bun test", passed: true, reason: "exit-zero", exitCode: 0, durationMs: 10, timeoutSeconds: 300, outputTail: [] },
  ],
  executableCount: 1,
  agentJudgedCount: 0,
};

const RED_GATES: GateReport = {
  passed: false,
  criterionResults: [
    { kind: "executable", description: "unit tests pass", command: "bun test", passed: false, reason: "exit-nonzero", exitCode: 1, durationMs: 10, timeoutSeconds: 300, outputTail: ["1 fail"] },
    {
      kind: "agent-judged",
      description: "review approves",
      passed: false,
      votes: [{ vote: "fail", remarks: "the noop path is untested" }, { vote: "pass" }],
    },
  ],
  executableCount: 1,
  agentJudgedCount: 1,
};

function resolved(noteId: string, decision: "accept" | "reject" | "supersede"): EventInput {
  return {
    type: "staging_resolve",
    note_id: noteId,
    decision,
    staged_to_resolved_ms: 0,
    commit: decision === "reject" ? null : "abc1234",
    superseded_id: decision === "supersede" ? "n0" : null,
    suggested: null,
    accepted_body_len: null,
    accepted_anchors_n: null,
    menu: { decision_class: "curation", options_n: 4, recommended_position: 2, chosen_position: 1 },
  };
}

function diaryEntry(noteId: string, runId: string): EventInput {
  return {
    type: "remember",
    note_id: noteId,
    note_type: "decision",
    body_len: 40,
    anchors_n: 0,
    tags_n: 2,
    tags: [DIARY_TAG, runTag(runId)],
    source: "mcp",
    dedup: dedupPayload("add", null, null, false, defaultConfig().dedup),
  };
}

// Two phases: the first fails its gate once (an executable criterion and a reviewer's fail vote),
// passes on the retry and stages three notes of two kinds; the second runs clean and stages none.
function completedTwoPhaseRun(log: Log): void {
  started(log, RUN_ID, "main", ["schema", "facts"]);
  applied(log, RUN_ID, "main", recallOf("schema", true));
  applied(log, RUN_ID, "main", executionOf("schema", 1, "failure", RED_GATES));
  applied(log, RUN_ID, "main", executionOf("schema", 2, "success", GREEN_GATES));
  applied(log, RUN_ID, "main", harvestOf(
    "schema",
    [{ id: "n-a", type: "decision" }, { id: "n-b", type: "bugfix" }, { id: "n-c", type: "decision" }],
    [{ id: "n-old", evidence: "followed its contract in run-executor.ts" }],
  ));
  applied(log, RUN_ID, "main", recallOf("facts", false));
  applied(log, RUN_ID, "main", executionOf("facts", 1, "success", GREEN_GATES));
  applied(log, RUN_ID, "main", harvestOf("facts", [], null));
}

function factsOf(answer: RunFactsAnswer): RunFacts {
  if (answer.kind !== "facts") throw new Error(`expected facts, got ${answer.kind}`);
  return answer.facts;
}

describe("runFacts of a completed run", () => {
  test("names the run, its span and its iteration budget", () => {
    const log = createLog();
    completedTwoPhaseRun(log);

    const facts = factsOf(runFacts(log.events(), RUN_ID));

    expect(facts.branch).toBe("main");
    expect(facts.status).toBe("complete");
    expect(facts.startedTs).toBe("2026-10-30T10:00:00.000Z");
    expect(facts.endedTs).toBe("2026-10-30T10:00:07.000Z");
    expect(facts.iterationsUsed).toBe(3);
    expect(facts.maxIterations).toBe(20);
    expect(facts.escalation).toBeNull();
    expect(facts.diaryEntry).toBe(false);
  });

  test("reads every phase's attempts, gate failures, bundle gap, harvest kinds and usage", () => {
    const log = createLog();
    completedTwoPhaseRun(log);

    const [schema, factsPhase] = factsOf(runFacts(log.events(), RUN_ID)).phases;

    expect(schema).toEqual({
      phaseId: "schema",
      reached: true,
      attempts: 2,
      bundleGap: true,
      harvest: {
        kind: "run",
        stagedByType: [{ type: "bugfix", count: 1 }, { type: "decision", count: 2 }],
        harvestedCount: 3,
        usedNotes: 1,
      },
      gateFailures: [
        { attempt: 1, kind: "executable", criterion: "unit tests pass", reason: "exit-nonzero", remarks: [] },
        { attempt: 1, kind: "agent-judged", criterion: "review approves", reason: "fail votes 1/2", remarks: ["the noop path is untested"] },
      ],
    });
    expect(factsPhase).toEqual({
      phaseId: "facts",
      reached: true,
      attempts: 1,
      bundleGap: false,
      harvest: { kind: "run", stagedByType: [], harvestedCount: 0, usedNotes: null },
      gateFailures: [],
    });
  });

  test("curation follows each staged note's latest human decision; an undecided note is still staged", () => {
    const log = createLog();
    completedTwoPhaseRun(log);
    log.append(resolved("n-a", "accept"));
    log.append(resolved("n-b", "reject"));
    log.append(resolved("n-unrelated", "accept"));

    expect(factsOf(runFacts(log.events(), RUN_ID)).curation).toEqual({
      staged: 1,
      accepted: 1,
      rejected: 1,
      superseded: 0,
      uninstrumentedHarvests: 0,
    });
  });

  test("a diary entry tagged for the run is reported present", () => {
    const log = createLog();
    completedTwoPhaseRun(log);
    log.append(diaryEntry("n-diary", RUN_ID));

    expect(factsOf(runFacts(log.events(), RUN_ID)).diaryEntry).toBe(true);
  });

  // NEUTRALITY: the menu a deciding call rode on is never rendered into a retro's facts.
  test("the rendered facts carry no trace of the menus the curation decisions rode on", () => {
    const log = createLog();
    completedTwoPhaseRun(log);
    log.append(resolved("n-a", "accept"));

    const rendered = renderRunAnswer(runFacts(log.events(), RUN_ID));

    expect(rendered).not.toMatch(/menu|recommend|chosen|agreement|options_n/);
  });
});

describe("runFacts of runs that ended otherwise", () => {
  test("an escalated run names where and why, and a phase it never reached", () => {
    const log = createLog();
    started(log, RUN_ID, "main", ["schema", "facts"], 1);
    applied(log, RUN_ID, "main", recallOf("schema", false));
    applied(log, RUN_ID, "main", executionOf("schema", 1, "failure", RED_GATES));

    const facts = factsOf(runFacts(log.events(), RUN_ID));

    expect(facts.status).toBe("escalated");
    expect(facts.escalation).toMatchObject({ phaseId: "schema", stepId: "implement" });
    expect(facts.phases[0]!.harvest).toEqual({ kind: "not-run" });
    expect(facts.phases[1]).toMatchObject({ phaseId: "facts", reached: false, attempts: 0 });
  });

  test("an abandoned run ends at its marker", () => {
    const log = createLog();
    started(log, RUN_ID, "main", ["schema"]);
    applied(log, RUN_ID, "main", recallOf("schema", false));
    log.append({ ...runAbandonedPayload(RUN_ID, "main", "superseded by a new plan"), type: "workflow_run_abandoned" });

    const facts = factsOf(runFacts(log.events(), RUN_ID));

    expect(facts.status).toBe("abandoned");
    expect(facts.endedTs).toBe("2026-10-30T10:00:02.000Z");
  });

  test("a run whose branch vanished ends at its stale mark", () => {
    const log = createLog();
    started(log, RUN_ID, "gone", ["schema"]);
    log.append({ ...runMarkedStalePayload(RUN_ID, "gone"), type: "workflow_run_marked_stale" });

    const facts = factsOf(runFacts(log.events(), RUN_ID));

    expect(facts.status).toBe("stale");
    expect(facts.endedTs).toBe("2026-10-30T10:00:01.000Z");
    expect(facts.phases[0]!.reached).toBe(false);
  });

  // Tolerance fixture: applications stamped before v22 carry neither gap nor staged_notes.
  test("a run from before v22 reports its bundle gap, harvest kinds and curation as not instrumented", () => {
    const log = createLog();
    started(log, RUN_ID, "main", ["schema"]);
    const recall = stepAppliedPayload(RUN_ID, "main", recallOf("schema", true));
    const harvest = stepAppliedPayload(RUN_ID, "main", harvestOf("schema", [{ id: "n-a", type: "decision" }], []));
    delete recall["gap"];
    delete recall["staged_notes"];
    delete harvest["gap"];
    delete harvest["staged_notes"];
    log.append({ ...recall, type: "workflow_step_applied" });
    applied(log, RUN_ID, "main", executionOf("schema", 1, "success", GREEN_GATES));
    log.append({ ...harvest, type: "workflow_step_applied" });

    const facts = factsOf(runFacts(log.events(), RUN_ID));

    expect(facts.phases[0]!.bundleGap).toBeNull();
    expect(facts.phases[0]!.harvest).toEqual({ kind: "run", stagedByType: null, harvestedCount: 1, usedNotes: 0 });
    expect(facts.curation).toEqual({ staged: 0, accepted: 0, rejected: 0, superseded: 0, uninstrumentedHarvests: 1 });
  });
});

describe("runFacts non-answers", () => {
  test("a run_id outside the id grammar is refused before the log is read", () => {
    expect(runFacts(createLog().events(), "../etc/passwd")).toEqual({ kind: "invalid-id" });
  });

  test("an id no run carries is unknown", () => {
    expect(runFacts(createLog().events(), RUN_ID)).toEqual({ kind: "unknown", runId: RUN_ID });
  });

  test("a run still running is no retro subject yet, and says on which branch it runs", () => {
    const log = createLog();
    started(log, RUN_ID, "feature", ["schema"]);

    expect(runFacts(log.events(), RUN_ID)).toEqual({ kind: "running", runId: RUN_ID, branch: "feature" });
  });

  test("a run the restore cannot read names the restore's problem", () => {
    const log = createLog();
    started(log, RUN_ID, "main", ["schema"]);
    applied(log, RUN_ID, "elsewhere", recallOf("schema", false));

    const answer = runFacts(log.events(), RUN_ID);

    expect(answer.kind).toBe("unreadable");
    expect(answer.kind === "unreadable" ? answer.problem : "").toContain('names branch "elsewhere"');
  });
});

describe("lastTerminalRunOf", () => {
  test("is the branch's newest-started finished run; a running run and other branches do not count", () => {
    const log = createLog();
    completedTwoPhaseRun(log);
    started(log, SECOND_RUN_ID, "main", ["schema"]);
    started(log, THIRD_RUN_ID, "feature", ["schema"]);
    log.append({ ...runAbandonedPayload(THIRD_RUN_ID, "feature", "dropped"), type: "workflow_run_abandoned" });

    expect(lastTerminalRunOf(log.events(), "main")).toEqual({ runId: RUN_ID, status: "complete", diaryEntry: false });
    expect(lastTerminalRunOf(log.events(), "feature")).toEqual({ runId: THIRD_RUN_ID, status: "abandoned", diaryEntry: false });
  });

  test("an abandoned run started later is the branch's last finished run", () => {
    const log = createLog();
    completedTwoPhaseRun(log);
    started(log, SECOND_RUN_ID, "main", ["schema"]);
    log.append({ ...runAbandonedPayload(SECOND_RUN_ID, "main", "dropped"), type: "workflow_run_abandoned" });

    expect(lastTerminalRunOf(log.events(), "main")).toEqual({ runId: SECOND_RUN_ID, status: "abandoned", diaryEntry: false });
  });

  test("names whether that run already has a diary entry", () => {
    const log = createLog();
    completedTwoPhaseRun(log);
    log.append(diaryEntry("n-diary", RUN_ID));

    expect(lastTerminalRunOf(log.events(), "main")).toEqual({ runId: RUN_ID, status: "complete", diaryEntry: true });
  });

  test("is null for a branch with no finished run", () => {
    const log = createLog();
    started(log, RUN_ID, "main", ["schema"]);

    expect(lastTerminalRunOf(log.events(), "main")).toBeNull();
    expect(lastTerminalRunOf(log.events(), "other")).toBeNull();
  });
});
