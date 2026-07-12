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
