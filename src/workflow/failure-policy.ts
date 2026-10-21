import { MAX_PHASE_ID_LENGTH, isPhaseId } from "./phase-document";

export class FailurePolicyValidationError extends Error {}

export type OnFailDirective =
  | { action: "rewind"; to: string }
  | { action: "skip" }
  | { action: "escalate" };

export interface StepDefinition {
  id: string;
  maxAttempts: number;
  onFail: OnFailDirective;
}

export type FailureResolution = { action: "retry" } | OnFailDirective;

export function resolveFailure(step: StepDefinition, failedAttempt: number): FailureResolution {
  return failedAttempt < step.maxAttempts ? { action: "retry" } : step.onFail;
}

// A gate run in which every red criterion timed out is inconclusive: the environment, not the code,
// is the suspect, so the step is re-issued without consuming its attempt. The bound keeps a gate
// that is simply too slow from re-running forever: after this many consecutive inconclusive runs of
// one attempt, the next one is resolved as an ordinary failure.
export const MAX_INCONCLUSIVE_GATE_RUNS = 2;

export type InconclusiveGateResolution = "re-run" | "count-as-failure";

export function resolveInconclusiveGate(inconclusiveGateRuns: number): InconclusiveGateResolution {
  return inconclusiveGateRuns < MAX_INCONCLUSIVE_GATE_RUNS ? "re-run" : "count-as-failure";
}

// "inconclusive" is never submitted by the agent: the executor derives it from a gate report whose
// every red criterion timed out.
export type StepOutcome = "success" | "failure" | "inconclusive";

export type StepEffect = "success" | "failure" | "environment-re-run";

// What an execute_step outcome does to the run, given the attempt's inconclusive runs BEFORE it. The
// reducer applies this, the executor renders its gate verdict from it and the restore fold absorbs
// the gate history by it, so none of them can disagree about whether a timeout was re-run or failed.
export function stepEffectOf(outcome: StepOutcome, inconclusiveGateRunsBefore: number): StepEffect {
  if (outcome === "success") {
    return "success";
  }
  if (outcome === "inconclusive" && resolveInconclusiveGate(inconclusiveGateRunsBefore) === "re-run") {
    return "environment-re-run";
  }
  return "failure";
}

export function validateRunPolicy(steps: StepDefinition[], maxIterations: number): void {
  if (steps.length === 0) {
    throw new FailurePolicyValidationError("a run policy requires at least one step");
  }
  const seenStepIds = new Set<string>();
  steps.forEach((step, stepIndex) => {
    validateStep(step, seenStepIds);
    validateRewindTarget(step, stepIndex, steps);
  });
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new FailurePolicyValidationError(
      `maxIterations must be a positive integer: ${maxIterations}`,
    );
  }
}

function validateStep(step: StepDefinition, seenStepIds: Set<string>): void {
  if (!isPhaseId(step.id)) {
    throw new FailurePolicyValidationError(
      `step id must be a kebab-case slug of at most ${MAX_PHASE_ID_LENGTH} characters: ${step.id}`,
    );
  }
  if (seenStepIds.has(step.id)) {
    throw new FailurePolicyValidationError(`duplicate step id: ${step.id}`);
  }
  seenStepIds.add(step.id);
  if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1) {
    throw new FailurePolicyValidationError(
      `step "${step.id}" maxAttempts must be a positive integer: ${step.maxAttempts}`,
    );
  }
}

function validateRewindTarget(step: StepDefinition, stepIndex: number, steps: StepDefinition[]): void {
  if (step.onFail.action !== "rewind") {
    return;
  }
  const targetId = step.onFail.to;
  const targetIndex = steps.findIndex((candidate) => candidate.id === targetId);
  if (targetIndex === -1) {
    throw new FailurePolicyValidationError(`step "${step.id}" rewinds to unknown step "${targetId}"`);
  }
  if (targetIndex >= stepIndex) {
    throw new FailurePolicyValidationError(
      `step "${step.id}" must rewind to a strictly earlier step, not "${targetId}"`,
    );
  }
}
