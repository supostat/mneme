import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../event-schema";
import { EventWriter, readEvents } from "../events";
import type { StepDefinition } from "./failure-policy";
import type { GateReport } from "./gate-runner";
import type { PhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import type { RunDefinition, StepResult } from "./reducer";
import {
  pendingDirectiveOf,
  restoreRuns,
  staleMarkedRunIds,
  unfinishedRunsOf,
} from "./run-events";
import type { ReadableRun, RestoredRun, UnreadableRun } from "./run-events";
import { runMarkedStalePayload, runStartedPayload, stepAppliedPayload } from "./run-payloads";
import type { StepApplication } from "./run-payloads";

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");
const EVENTS_FILE = "2026-07.jsonl";

// Restore enforces the note-id grammar on run ids, so fixture runs carry genuine ULIDs.
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const SECOND_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const GHOST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const CORRUPTED_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA3";

function phaseDocument(id: string, deps: string[] = []): PhaseDocument {
  return {
    id,
    deps,
    agentRole: "coder",
    description: `Work on ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "tests pass", command: "true" }],
  };
}

function makeDefinition(phases: PhaseDocument[]): RunDefinition {
  return {
    graph: buildPhaseGraph(phases),
    steps: [
      { id: "implement", maxAttempts: 2, onFail: { action: "escalate" } },
      { id: "verify", maxAttempts: 1, onFail: { action: "escalate" } },
    ] satisfies StepDefinition[],
    maxIterations: 10,
  };
}

const RETRIEVAL = { recallBudget: 2000, recallAnchors: { "phase-one": ["src/a.ts"] } };

interface LogFixture {
  eventsDir: string;
  writer: EventWriter;
}

function makeLog(): LogFixture {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-run-events-"));
  const writer = new EventWriter(eventsDir, {
    sessionId: "s-run-events",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  return { eventsDir, writer };
}

function appendStarted(log: LogFixture, runId: string, branch: string, definition: RunDefinition): void {
  log.writer.append({ ...runStartedPayload(runId, branch, definition, RETRIEVAL), type: "workflow_run_started" });
}

function appendApplied(log: LogFixture, runId: string, branch: string, application: StepApplication): void {
  log.writer.append({ ...stepAppliedPayload(runId, branch, application), type: "workflow_step_applied" });
}

function application(result: StepResult, attempt: number | null = null): StepApplication {
  return { result, attempt, gates: null, harvestedCount: null };
}

function executeSuccess(phaseId: string, stepId: string, attempt: number): StepApplication {
  return application({ kind: "execute_step", phaseId, stepId, outcome: "success" }, attempt);
}

function restoreLog(log: LogFixture): RestoredRun[] {
  return restoreRuns(readEvents(log.eventsDir));
}

function onlyRun(log: LogFixture): ReadableRun {
  const runs = restoreLog(log);
  expect(runs.length).toBe(1);
  const run = runs[0]!;
  if (run.kind !== "restored") throw new Error(`expected a restored run, got: ${run.problem}`);
  return run;
}

function onlyUnreadable(log: LogFixture): UnreadableRun {
  const runs = restoreLog(log);
  expect(runs.length).toBe(1);
  const run = runs[0]!;
  if (run.kind !== "unreadable") throw new Error("expected an unreadable run");
  return run;
}

// Mutates a payload clone through JSON so unreadable fixtures corrupt exactly one field of an
// otherwise-genuine event.
function corruptedStartedEvent(
  definition: RunDefinition,
  corrupt: (payload: Record<string, unknown>) => void,
): Record<string, unknown> {
  const payload = JSON.parse(
    JSON.stringify(runStartedPayload(CORRUPTED_RUN_ID, "main", definition, RETRIEVAL)),
  ) as Record<string, unknown>;
  corrupt(payload);
  return { ...payload, type: "workflow_run_started" };
}

function definitionOf(event: Record<string, unknown>): Record<string, unknown> {
  return event["definition"] as Record<string, unknown>;
}

describe("restoreRuns folds a genuine log", () => {
  test("started + recall + one step success restores the mid-phase state and retrieval config", () => {
    const log = makeLog();
    const definition = makeDefinition([phaseDocument("phase-one")]);
    appendStarted(log, RUN_ID, "main", definition);
    appendApplied(log, RUN_ID, "main", application({ kind: "recall", phaseId: "phase-one" }));
    appendApplied(log, RUN_ID, "main", executeSuccess("phase-one", "implement", 1));

    const run = onlyRun(log);

    expect(run.runId).toBe(RUN_ID);
    expect(run.branch).toBe("main");
    expect(run.startedTs).toBe("2026-07-06T10:00:00.000Z");
    expect(run.retrieval).toEqual(RETRIEVAL);
    expect(run.run.status).toBe("running");
    expect(run.run.activePhaseId).toBe("phase-one");
    expect(run.run.stepIndex).toBe(1);
    // Restored from the log alone (no live workflow_start), the directive still carries the phase
    // intent and enumerated tasks — the self-sufficiency that lets a resumed session act without
    // re-reading the phase file.
    expect(pendingDirectiveOf(run)).toEqual({
      kind: "execute_step",
      phaseId: "phase-one",
      stepId: "verify",
      agentRole: "coder",
      description: "Work on phase-one",
      tasks: ["do the work"],
      attempt: 1,
    });
    expect(unfinishedRunsOf([run], new Set())).toEqual([run]);
  });

  test("a full phase cycle through harvest restores a complete run that is no longer unfinished", () => {
    const log = makeLog();
    const definition = makeDefinition([phaseDocument("phase-one")]);
    const gates: GateReport = {
      passed: true,
      criterionResults: [
        { kind: "executable", description: "tests pass", command: "true", passed: true, reason: "exit-zero", exitCode: 0 },
      ],
      executableCount: 1,
      agentJudgedCount: 0,
    };
    appendStarted(log, RUN_ID, "main", definition);
    appendApplied(log, RUN_ID, "main", application({ kind: "recall", phaseId: "phase-one" }));
    appendApplied(log, RUN_ID, "main", executeSuccess("phase-one", "implement", 1));
    appendApplied(log, RUN_ID, "main", { ...executeSuccess("phase-one", "verify", 1), gates });
    appendApplied(log, RUN_ID, "main", { ...application({ kind: "harvest", phaseId: "phase-one" }), harvestedCount: 2 });

    const run = onlyRun(log);

    expect(run.run.status).toBe("complete");
    expect(pendingDirectiveOf(run)).toEqual({ kind: "run_complete" });
    expect(unfinishedRunsOf([run], new Set())).toEqual([]);
  });

  test("two started runs with distinct ids on one branch both restore as running (log anomaly)", () => {
    const log = makeLog();
    const definition = makeDefinition([phaseDocument("phase-one")]);
    appendStarted(log, RUN_ID, "main", definition);
    appendStarted(log, SECOND_RUN_ID, "main", definition);

    const runs = restoreLog(log);

    expect(runs.map((run) => run.kind)).toEqual(["restored", "restored"]);
    expect(unfinishedRunsOf(runs, new Set()).map((run) => run.runId)).toEqual([RUN_ID, SECOND_RUN_ID]);
  });
});

describe("restoreRuns yields unreadable, never a crash", () => {
  const definition = makeDefinition([phaseDocument("phase-one")]);

  test("a definition whose phase has an empty done_when fails validatePhaseDocument", () => {
    const log = makeLog();
    log.writer.append(
      corruptedStartedEvent(definition, (payload) => {
        const phases = definitionOf(payload)["phases"] as Array<Record<string, unknown>>;
        phases[0]!["done_when"] = [];
      }) as { type: string } & Record<string, unknown>,
    );

    expect(onlyUnreadable(log).problem).toContain("Done-when");
  });

  test("an executable criterion with a null command is unreadable", () => {
    const log = makeLog();
    log.writer.append(
      corruptedStartedEvent(definition, (payload) => {
        const phases = definitionOf(payload)["phases"] as Array<Record<string, unknown>>;
        const doneWhen = phases[0]!["done_when"] as Array<Record<string, unknown>>;
        doneWhen[0]!["command"] = null;
      }) as { type: string } & Record<string, unknown>,
    );

    expect(onlyUnreadable(log).problem).toContain("missing its command");
  });

  test("a rewind step whose target is null is unreadable", () => {
    const log = makeLog();
    log.writer.append(
      corruptedStartedEvent(definition, (payload) => {
        const steps = definitionOf(payload)["steps"] as Array<Record<string, unknown>>;
        steps[1]!["on_fail"] = { action: "rewind", to: null };
      }) as { type: string } & Record<string, unknown>,
    );

    expect(onlyUnreadable(log).problem).toContain("rewind");
  });

  test("a started event whose run_id fails the ULID/UUID grammar is unreadable", () => {
    const log = makeLog();
    log.writer.append({
      ...runStartedPayload("../escape", "main", definition, RETRIEVAL),
      type: "workflow_run_started",
    });

    const unreadable = onlyUnreadable(log);
    expect(unreadable.runId).toBe("../escape");
    expect(unreadable.problem).toContain("ULID/UUID id grammar");
  });

  test("a started event failing the restore schema is unreadable with its branch when readable", () => {
    const log = makeLog();
    log.writer.append({ type: "workflow_run_started", run_id: CORRUPTED_RUN_ID, branch: "main", definition: 7 });

    const unreadable = onlyUnreadable(log);
    expect(unreadable.branch).toBe("main");
    expect(unreadable.problem).toContain("failed schema validation");
  });

  test("a ghost step_applied without its started event is unreadable", () => {
    const log = makeLog();
    appendApplied(log, GHOST_RUN_ID, "main", application({ kind: "recall", phaseId: "phase-one" }));

    const unreadable = onlyUnreadable(log);
    expect(unreadable.runId).toBe(GHOST_RUN_ID);
    expect(unreadable.problem).toContain("without a preceding workflow_run_started");
  });

  test("a ghost step_applied whose run_id fails the id grammar reports the grammar problem", () => {
    const log = makeLog();
    appendApplied(log, "../ghost-escape", "main", application({ kind: "recall", phaseId: "phase-one" }));

    const unreadable = onlyUnreadable(log);
    expect(unreadable.runId).toBe("../ghost-escape");
    expect(unreadable.problem).toContain("ULID/UUID id grammar");
  });

  test("a step_applied naming a different branch than the run is unreadable", () => {
    const log = makeLog();
    appendStarted(log, RUN_ID, "main", definition);
    appendApplied(log, RUN_ID, "feature", application({ kind: "recall", phaseId: "phase-one" }));

    const unreadable = onlyUnreadable(log);
    expect(unreadable.problem).toContain('names branch "feature"');
  });

  test("a step_applied that contradicts the reducer's pending directive is unreadable", () => {
    const log = makeLog();
    appendStarted(log, RUN_ID, "main", definition);
    appendApplied(log, RUN_ID, "main", executeSuccess("phase-one", "implement", 1));

    expect(onlyUnreadable(log).problem).toContain("expected a recall completion");
  });

  test("a duplicate started for one run_id is unreadable", () => {
    const log = makeLog();
    appendStarted(log, RUN_ID, "main", definition);
    appendStarted(log, RUN_ID, "main", definition);

    expect(onlyUnreadable(log).problem).toContain("duplicate workflow_run_started");
  });

  test("a malformed step_applied on a known run is unreadable", () => {
    const log = makeLog();
    appendStarted(log, RUN_ID, "main", definition);
    log.writer.append({
      type: "workflow_step_applied",
      run_id: RUN_ID,
      branch: "main",
      phase_id: "phase-one",
      result_kind: "recall",
      step_id: null,
      outcome: null,
      attempt: "one",
      gates: null,
      harvested_n: null,
    });

    expect(onlyUnreadable(log).problem).toContain("failed schema validation");
  });
});

describe("stale marking", () => {
  test("a marked-stale run is excluded from unfinished runs forever", () => {
    const log = makeLog();
    appendStarted(log, RUN_ID, "feature", makeDefinition([phaseDocument("phase-one")]));
    log.writer.append({ ...runMarkedStalePayload(RUN_ID, "feature"), type: "workflow_run_marked_stale" });

    const events = readEvents(log.eventsDir);
    const staleIds = staleMarkedRunIds(events);

    expect(staleIds).toEqual(new Set([RUN_ID]));
    expect(unfinishedRunsOf(restoreRuns(events), staleIds)).toEqual([]);
  });

  test("even a schema-invalid stale marker still poisons its run (fail safe)", () => {
    const log = makeLog();
    log.writer.append({ type: "workflow_run_marked_stale", run_id: RUN_ID, reason: "frobnicate" });

    expect(staleMarkedRunIds(readEvents(log.eventsDir))).toEqual(new Set([RUN_ID]));
  });
});

describe("restore tolerance", () => {
  test("a started event stamped with a FUTURE schema_version still restores", () => {
    const log = makeLog();
    const raw = {
      ...runStartedPayload(RUN_ID, "main", makeDefinition([phaseDocument("phase-one")]), RETRIEVAL),
      type: "workflow_run_started",
      session_id: "s-future",
      ts: "2026-07-06T10:00:00.000Z",
      mneme_version: "9.9.9",
      schema_version: SCHEMA_VERSION + 1,
    };
    appendFileSync(join(log.eventsDir, EVENTS_FILE), JSON.stringify(raw) + "\n");

    const run = onlyRun(log);
    expect(run.runId).toBe(RUN_ID);
    expect(run.run.status).toBe("running");
  });

  test("garbage lines and events without a string run_id are skipped without harming valid runs", () => {
    const log = makeLog();
    appendFileSync(join(log.eventsDir, EVENTS_FILE), "{not json\n");
    log.writer.append({ type: "workflow_run_started", run_id: 42, branch: "main" });
    log.writer.append({ type: "workflow_step_applied", run_id: 42, branch: "main" });
    appendStarted(log, RUN_ID, "main", makeDefinition([phaseDocument("phase-one")]));

    const run = onlyRun(log);
    expect(run.runId).toBe(RUN_ID);
  });
});

describe("payload shape", () => {
  test("no workflow payload carries a type key of its own", () => {
    const definition = makeDefinition([phaseDocument("phase-one")]);
    const payloads = [
      runStartedPayload(RUN_ID, "main", definition, RETRIEVAL),
      stepAppliedPayload(RUN_ID, "main", executeSuccess("phase-one", "implement", 1)),
      runMarkedStalePayload(RUN_ID, "main"),
    ];

    for (const payload of payloads) {
      expect(Object.keys(payload)).not.toContain("type");
    }
  });
});
