import { selectNextReadyPhase } from "./phase-graph";
import type { PhaseStatus } from "./phase-graph";
import type { PhaseDocument } from "./phase-document";
import type { StepDefinition } from "./failure-policy";
import { resolveFailure, validateRunPolicy } from "./failure-policy";
import type {
  Directive,
  ExecuteStepResult,
  RunDefinition,
  RunEscalation,
  StepResult,
  WorkflowRun,
} from "./run-state";

export type {
  Directive,
  ExecuteStepDirective,
  ExecuteStepResult,
  HarvestDirective,
  HarvestStepResult,
  RecallDirective,
  RecallStepResult,
  RunDefinition,
  RunEscalation,
  RunStatus,
  StepResult,
  WorkflowRun,
} from "./run-state";

// Recall opens a phase and harvest closes it as the engine's own lifecycle steps: a phase is entered
// through a recall directive and, after its final step succeeds, left through a harvest directive — a
// failure path never dispenses harvest. Their completions carry no outcome and no retry budget:
// recall never fails hard (the degradation convention) and a green phase's closure must not be gated
// on memory bookkeeping; executor-side errors are the caller's policy. They also consume no
// iterations — the budget bounds agent-step executions, while lifecycle steps are structurally
// bounded by phase count.

export class WorkflowStateError extends Error {}

const MAX_ITERATIONS_EXHAUSTED = "max_iterations_exhausted";
const RETRY_BUDGET_EXHAUSTED = "retry_budget_exhausted";

export function initialRun(definition: RunDefinition): WorkflowRun {
  validateRunPolicy(definition.steps, definition.maxIterations);
  const phaseStatuses: Record<string, PhaseStatus> = {};
  for (const phaseId of Object.keys(definition.graph.phases)) {
    phaseStatuses[phaseId] = "pending";
  }
  return {
    status: "running",
    phaseStatuses,
    activePhaseId: null,
    stepIndex: 0,
    stepAttempts: definition.steps.map(() => 0),
    iterationsUsed: 0,
    failureReason: null,
    escalation: null,
  };
}

export function reduce(run: WorkflowRun, definition: RunDefinition): Directive {
  const terminal = terminalDirective(run);
  if (terminal !== null) {
    return terminal;
  }
  if (run.activePhaseId === null) {
    const phaseId = selectNextReadyPhase(definition.graph, run.phaseStatuses);
    if (phaseId === null) {
      throw new Error("running workflow has no ready phase: dependency graph invariant violated");
    }
    return { kind: "recall", phaseId };
  }
  if (harvestPending(run, definition)) {
    return { kind: "harvest", phaseId: run.activePhaseId };
  }
  const activePhase = phaseOf(definition, run.activePhaseId);
  return {
    kind: "execute_step",
    phaseId: run.activePhaseId,
    stepId: stepAt(definition, run.stepIndex).id,
    agentRole: activePhase.agentRole,
    description: activePhase.description,
    tasks: [...activePhase.tasks],
    attempt: attemptsAt(run, run.stepIndex) + 1,
  };
}

function terminalDirective(run: WorkflowRun): Directive | null {
  if (run.status === "complete") {
    return { kind: "run_complete" };
  }
  if (run.status === "failed") {
    return { kind: "run_failed", reason: requireFailureReason(run) };
  }
  if (run.status === "escalated") {
    const escalation = requireEscalation(run);
    return {
      kind: "escalate",
      phaseId: escalation.phaseId,
      stepId: escalation.stepId,
      reason: escalation.reason,
    };
  }
  return null;
}

export function applyStepResult(
  run: WorkflowRun,
  definition: RunDefinition,
  result: StepResult,
): WorkflowRun {
  requireMatchingDirective(run, reduce(run, definition), result);
  const next: WorkflowRun = {
    ...run,
    phaseStatuses: { ...run.phaseStatuses },
    stepAttempts: [...run.stepAttempts],
  };
  if (result.kind === "recall") {
    next.activePhaseId = result.phaseId;
    return next;
  }
  if (result.kind === "harvest") {
    closeActivePhase(next);
    failWhenExhausted(next, definition);
    return next;
  }
  applyExecuteStepResult(next, definition, result);
  return next;
}

function applyExecuteStepResult(
  next: WorkflowRun,
  definition: RunDefinition,
  result: ExecuteStepResult,
): void {
  next.iterationsUsed += 1;
  if (result.outcome === "success") {
    next.stepIndex += 1;
  } else {
    applyFailure(next, definition, result);
  }
  if (!harvestPending(next, definition)) {
    failWhenExhausted(next, definition);
  }
}

function harvestPending(run: WorkflowRun, definition: RunDefinition): boolean {
  return run.activePhaseId !== null && run.stepIndex === definition.steps.length;
}

function requireMatchingDirective(run: WorkflowRun, expected: Directive, result: StepResult): void {
  if (expected.kind !== "execute_step" && expected.kind !== "recall" && expected.kind !== "harvest") {
    throw new WorkflowStateError(`cannot apply a step result to a ${run.status} run`);
  }
  if (expected.kind !== result.kind) {
    throw new WorkflowStateError(
      `expected a ${expected.kind} completion, received ${result.kind}`,
    );
  }
  if (expected.phaseId !== result.phaseId) {
    throw new WorkflowStateError(
      `expected a result for phase ${expected.phaseId}, received ${result.phaseId}`,
    );
  }
  if (expected.kind === "execute_step" && result.kind === "execute_step" && expected.stepId !== result.stepId) {
    throw new WorkflowStateError(
      `expected a result for ${expected.phaseId}/${expected.stepId}, ` +
        `received ${result.phaseId}/${result.stepId}`,
    );
  }
}

function failWhenExhausted(next: WorkflowRun, definition: RunDefinition): void {
  if (next.status === "running" && next.iterationsUsed >= definition.maxIterations) {
    next.status = "failed";
    next.failureReason = MAX_ITERATIONS_EXHAUSTED;
  }
}

function closeActivePhase(next: WorkflowRun): void {
  if (next.activePhaseId === null) {
    throw new Error("closing a phase requires an active phase");
  }
  next.phaseStatuses[next.activePhaseId] = "closed";
  next.activePhaseId = null;
  next.stepIndex = 0;
  next.stepAttempts = next.stepAttempts.map(() => 0);
  const allClosed = Object.values(next.phaseStatuses).every((status) => status === "closed");
  if (allClosed) {
    next.status = "complete";
  }
}

function applyFailure(
  next: WorkflowRun,
  definition: RunDefinition,
  result: ExecuteStepResult,
): void {
  const step = stepAt(definition, next.stepIndex);
  const failedAttempt = attemptsAt(next, next.stepIndex) + 1;
  const resolution = resolveFailure(step, failedAttempt);
  if (resolution.action === "retry") {
    next.stepAttempts[next.stepIndex] = failedAttempt;
    return;
  }
  if (resolution.action === "rewind") {
    rewindTo(next, definition, resolution.to);
    return;
  }
  if (resolution.action === "skip") {
    skipStep(next, definition);
    return;
  }
  next.status = "escalated";
  next.escalation = {
    phaseId: result.phaseId,
    stepId: result.stepId,
    reason: RETRY_BUDGET_EXHAUSTED,
  };
}

// A skipped FINAL step closes the phase directly, never leaving a harvest pending: harvest is
// dispensed on success paths only.
function skipStep(next: WorkflowRun, definition: RunDefinition): void {
  if (next.stepIndex + 1 < definition.steps.length) {
    next.stepIndex += 1;
    return;
  }
  closeActivePhase(next);
}

function rewindTo(next: WorkflowRun, definition: RunDefinition, targetStepId: string): void {
  const targetIndex = definition.steps.findIndex((step) => step.id === targetStepId);
  if (targetIndex === -1) {
    throw new Error(`rewind target "${targetStepId}" is not in the validated step sequence`);
  }
  next.stepIndex = targetIndex;
  for (let stepIndex = targetIndex; stepIndex < next.stepAttempts.length; stepIndex += 1) {
    next.stepAttempts[stepIndex] = 0;
  }
}

function stepAt(definition: RunDefinition, stepIndex: number): StepDefinition {
  const step = definition.steps[stepIndex];
  if (step === undefined) {
    throw new Error(`step index ${stepIndex} is outside the validated step sequence`);
  }
  return step;
}

function phaseOf(definition: RunDefinition, phaseId: string): PhaseDocument {
  const phase = definition.graph.phases[phaseId];
  if (phase === undefined) {
    throw new Error(`phase "${phaseId}" is not in the validated graph`);
  }
  return phase;
}

function attemptsAt(run: WorkflowRun, stepIndex: number): number {
  const attempts = run.stepAttempts[stepIndex];
  if (attempts === undefined) {
    throw new Error(`no attempt counter for step index ${stepIndex}`);
  }
  return attempts;
}

function requireFailureReason(run: WorkflowRun): string {
  if (run.failureReason === null) {
    throw new Error("a failed run must carry a failure reason");
  }
  return run.failureReason;
}

function requireEscalation(run: WorkflowRun): RunEscalation {
  if (run.escalation === null) {
    throw new Error("an escalated run must carry an escalation");
  }
  return run.escalation;
}
