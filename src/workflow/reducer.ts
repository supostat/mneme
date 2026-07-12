import type { PhaseGraph, PhaseStatus } from "./phase-graph";
import { selectNextReadyPhase } from "./phase-graph";
import type { StepDefinition } from "./failure-policy";
import { resolveFailure, validateRunPolicy } from "./failure-policy";

export class WorkflowStateError extends Error {}

export interface RunDefinition {
  graph: PhaseGraph;
  steps: StepDefinition[];
  maxIterations: number;
}

export type RunStatus = "running" | "complete" | "failed" | "escalated";

export interface RunEscalation {
  phaseId: string;
  stepId: string;
  reason: string;
}

export interface WorkflowRun {
  status: RunStatus;
  phaseStatuses: Record<string, PhaseStatus>;
  activePhaseId: string | null;
  stepIndex: number;
  stepAttempts: number[];
  iterationsUsed: number;
  failureReason: string | null;
  escalation: RunEscalation | null;
}

export interface ExecuteStepDirective {
  kind: "execute_step";
  phaseId: string;
  stepId: string;
  agentRole: string;
  attempt: number;
}

export type Directive =
  | ExecuteStepDirective
  | { kind: "run_complete" }
  | { kind: "run_failed"; reason: string }
  | { kind: "escalate"; phaseId: string; stepId: string; reason: string };

export interface StepResult {
  phaseId: string;
  stepId: string;
  outcome: "success" | "failure";
}

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
  const phaseId = run.activePhaseId ?? selectNextReadyPhase(definition.graph, run.phaseStatuses);
  if (phaseId === null) {
    throw new Error("running workflow has no ready phase: dependency graph invariant violated");
  }
  return {
    kind: "execute_step",
    phaseId,
    stepId: stepAt(definition, run.stepIndex).id,
    agentRole: agentRoleOf(definition, phaseId),
    attempt: attemptsAt(run, run.stepIndex) + 1,
  };
}

export function applyStepResult(
  run: WorkflowRun,
  definition: RunDefinition,
  result: StepResult,
): WorkflowRun {
  const expected = requireExpectedStep(run, definition, result);
  const next: WorkflowRun = {
    ...run,
    phaseStatuses: { ...run.phaseStatuses },
    stepAttempts: [...run.stepAttempts],
    iterationsUsed: run.iterationsUsed + 1,
    activePhaseId: expected.phaseId,
  };
  if (result.outcome === "success") {
    advanceStep(next, definition);
  } else {
    applyFailure(next, definition, expected);
  }
  if (next.status === "running" && next.iterationsUsed >= definition.maxIterations) {
    next.status = "failed";
    next.failureReason = MAX_ITERATIONS_EXHAUSTED;
  }
  return next;
}

function requireExpectedStep(
  run: WorkflowRun,
  definition: RunDefinition,
  result: StepResult,
): ExecuteStepDirective {
  const expected = reduce(run, definition);
  if (expected.kind !== "execute_step") {
    throw new WorkflowStateError(`cannot apply a step result to a ${run.status} run`);
  }
  if (expected.phaseId !== result.phaseId || expected.stepId !== result.stepId) {
    throw new WorkflowStateError(
      `expected a result for ${expected.phaseId}/${expected.stepId}, ` +
        `received ${result.phaseId}/${result.stepId}`,
    );
  }
  return expected;
}

function advanceStep(next: WorkflowRun, definition: RunDefinition): void {
  if (next.stepIndex + 1 < definition.steps.length) {
    next.stepIndex += 1;
    return;
  }
  closeActivePhase(next);
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
  expected: ExecuteStepDirective,
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
    advanceStep(next, definition);
    return;
  }
  next.status = "escalated";
  next.escalation = {
    phaseId: expected.phaseId,
    stepId: expected.stepId,
    reason: RETRY_BUDGET_EXHAUSTED,
  };
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

function agentRoleOf(definition: RunDefinition, phaseId: string): string {
  const phase = definition.graph.phases[phaseId];
  if (phase === undefined) {
    throw new Error(`phase "${phaseId}" is not in the validated graph`);
  }
  return phase.agentRole;
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
