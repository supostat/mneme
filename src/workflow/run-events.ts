import type { z } from "zod";
import { workflowRunStartedRestore, workflowStepAppliedRestore } from "../event-schema";
import type { StoredEvent } from "../events";
import { isNoteId } from "../note";
import type { StepDefinition, OnFailDirective } from "./failure-policy";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";
import { validatePhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import { applyStepResult, initialRun, reduce } from "./reducer";
import type { Directive, RunDefinition, StepResult, WorkflowRun } from "./reducer";

// Pure, total restore of workflow runs from the event log (producer serialization lives in
// run-payloads.ts). Restore parses with the version-TOLERANT *Restore schema variants (see the v4
// changelog rule in event-schema.ts) so a future version bump never renders a live run unreadable;
// ANY restore failure yields an unreadable run, never a crash.

type RunStartedPayload = z.infer<typeof workflowRunStartedRestore>;
type StepAppliedPayload = z.infer<typeof workflowStepAppliedRestore>;

const ID_GRAMMAR_PROBLEM = "run_id does not match the ULID/UUID id grammar";

export interface RunRetrievalConfig {
  recallBudget: number;
  recallAnchors: Record<string, string[]>;
}

export interface ReadableRun {
  kind: "restored";
  runId: string;
  branch: string;
  definition: RunDefinition;
  retrieval: RunRetrievalConfig;
  run: WorkflowRun;
  startedTs: string;
}

export interface UnreadableRun {
  kind: "unreadable";
  runId: string;
  branch: string | null;
  problem: string;
}

export type RestoredRun = ReadableRun | UnreadableRun;

export function restoreRuns(events: StoredEvent[]): RestoredRun[] {
  const runsById = new Map<string, RestoredRun>();
  for (const event of events) {
    if (event.type === "workflow_run_started") {
      absorbRunStarted(runsById, event);
    } else if (event.type === "workflow_step_applied") {
      absorbStepApplied(runsById, event);
    }
  }
  return [...runsById.values()];
}

export function staleMarkedRunIds(events: StoredEvent[]): Set<string> {
  const staleRunIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "workflow_run_marked_stale") continue;
    // Fail safe: even a schema-invalid stale marker still poisons its run — a run marked stale must
    // never resume, so the marker is honored on the raw run_id alone.
    const runId = stringField(event, "run_id");
    if (runId !== null) staleRunIds.add(runId);
  }
  return staleRunIds;
}

export function unfinishedRunsOf(runs: RestoredRun[], staleRunIds: Set<string>): ReadableRun[] {
  return runs.filter(
    (run): run is ReadableRun =>
      run.kind === "restored" && run.run.status === "running" && !staleRunIds.has(run.runId),
  );
}

export function phaseOf(definition: RunDefinition, phaseId: string): PhaseDocument {
  const phase = definition.graph.phases[phaseId];
  if (phase === undefined) {
    throw new Error(`phase "${phaseId}" is not in the validated graph`);
  }
  return phase;
}

// A pending execute_step directive indexes the run's current step, so finality is a plain bounds check.
export function isFinalStep(definition: RunDefinition, run: WorkflowRun): boolean {
  return run.stepIndex === definition.steps.length - 1;
}

export function pendingDirectiveOf(active: ReadableRun): Directive {
  return reduce(active.run, active.definition);
}

function absorbRunStarted(runsById: Map<string, RestoredRun>, event: StoredEvent): void {
  // An event whose run_id is not even a string cannot name a run to restore or refuse; skip it.
  const runId = stringField(event, "run_id");
  if (runId === null) return;
  // Run ids share the note-id grammar (ULID/UUID): a tampered id could otherwise reach responses.
  if (!isNoteId(runId)) {
    setUnreadable(runsById, runId, stringField(event, "branch"), ID_GRAMMAR_PROBLEM);
    return;
  }
  const parsed = workflowRunStartedRestore.safeParse(event);
  if (!parsed.success) {
    setUnreadable(runsById, runId, stringField(event, "branch"), "workflow_run_started failed schema validation");
    return;
  }
  if (runsById.has(runId)) {
    setUnreadable(runsById, runId, parsed.data.branch, "duplicate workflow_run_started for one run_id");
    return;
  }
  try {
    runsById.set(runId, restoredRunFrom(runId, parsed.data));
  } catch (error) {
    setUnreadable(runsById, runId, parsed.data.branch, problemMessage(error));
  }
}

function restoredRunFrom(runId: string, payload: RunStartedPayload): ReadableRun {
  const definition = payloadToDefinition(payload.definition);
  return {
    kind: "restored",
    runId,
    branch: payload.branch,
    definition,
    retrieval: {
      recallBudget: payload.definition.recall_budget,
      recallAnchors: payload.definition.recall_anchors,
    },
    run: initialRun(definition),
    startedTs: payload.ts,
  };
}

function absorbStepApplied(runsById: Map<string, RestoredRun>, event: StoredEvent): void {
  const runId = stringField(event, "run_id");
  if (runId === null) return;
  const known = runsById.get(runId);
  if (known === undefined) {
    setUnreadable(runsById, runId, stringField(event, "branch"), ghostProblemOf(runId));
    return;
  }
  if (known.kind === "unreadable") return;
  const parsed = workflowStepAppliedRestore.safeParse(event);
  if (!parsed.success) {
    setUnreadable(runsById, runId, known.branch, "workflow_step_applied failed schema validation");
    return;
  }
  if (parsed.data.branch !== known.branch) {
    setUnreadable(
      runsById,
      runId,
      known.branch,
      `workflow_step_applied names branch "${parsed.data.branch}" but the run started on "${known.branch}"`,
    );
    return;
  }
  try {
    known.run = applyStepResult(known.run, known.definition, stepResultFromPayload(parsed.data));
  } catch (error) {
    setUnreadable(runsById, runId, known.branch, problemMessage(error));
  }
}

function payloadToDefinition(payload: RunStartedPayload["definition"]): RunDefinition {
  const documents = payload.phases.map((phase) =>
    validatePhaseDocument({
      id: phase.id,
      deps: phase.deps,
      agentRole: phase.agent_role,
      description: phase.description,
      tasks: phase.tasks,
      doneWhen: phase.done_when.map(criterionFromPayload),
    }),
  );
  return {
    graph: buildPhaseGraph(documents),
    steps: payload.steps.map(stepFromPayload),
    maxIterations: payload.max_iterations,
  };
}

function criterionFromPayload(
  payload: RunStartedPayload["definition"]["phases"][number]["done_when"][number],
): DoneWhenCriterion {
  if (payload.kind === "agent-judged") {
    return { kind: "agent-judged", description: payload.description };
  }
  if (payload.command === null) {
    throw new Error(`executable done-when criterion "${payload.description}" is missing its command`);
  }
  return { kind: "executable", description: payload.description, command: payload.command };
}

function stepFromPayload(payload: RunStartedPayload["definition"]["steps"][number]): StepDefinition {
  return { id: payload.id, maxAttempts: payload.max_attempts, onFail: onFailFromPayload(payload.on_fail) };
}

function onFailFromPayload(
  payload: RunStartedPayload["definition"]["steps"][number]["on_fail"],
): OnFailDirective {
  if (payload.action === "rewind") {
    if (payload.to === null) {
      throw new Error("a rewind on_fail is missing its target step");
    }
    return { action: "rewind", to: payload.to };
  }
  return { action: payload.action };
}

function stepResultFromPayload(payload: StepAppliedPayload): StepResult {
  if (payload.result_kind === "recall") {
    return { kind: "recall", phaseId: payload.phase_id };
  }
  if (payload.result_kind === "harvest") {
    return { kind: "harvest", phaseId: payload.phase_id };
  }
  if (payload.step_id === null || payload.outcome === null) {
    throw new Error("an execute_step application requires step_id and outcome");
  }
  return { kind: "execute_step", phaseId: payload.phase_id, stepId: payload.step_id, outcome: payload.outcome };
}

// A ghost applied event never passed the started-path grammar check, so its id gets it here: a
// tampered ghost id must surface as a grammar problem, never echo through the unreadable notice.
function ghostProblemOf(runId: string): string {
  return isNoteId(runId)
    ? "workflow_step_applied without a preceding workflow_run_started"
    : ID_GRAMMAR_PROBLEM;
}

function setUnreadable(
  runsById: Map<string, RestoredRun>,
  runId: string,
  branch: string | null,
  problem: string,
): void {
  runsById.set(runId, { kind: "unreadable", runId, branch, problem });
}

function stringField(event: StoredEvent, key: string): string | null {
  const value = event[key];
  return typeof value === "string" ? value : null;
}

function problemMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
