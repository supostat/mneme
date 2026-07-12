import { describe, expect, test } from "bun:test";
import {
  FailurePolicyValidationError,
  resolveFailure,
  validateRunPolicy,
} from "./failure-policy";
import type { StepDefinition } from "./failure-policy";

function step(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return { id: "code", maxAttempts: 3, onFail: { action: "escalate" }, ...overrides };
}

function validateWith(steps: StepDefinition[], maxIterations = 10): () => void {
  return () => validateRunPolicy(steps, maxIterations);
}

describe("resolveFailure", () => {
  test("a failure under the attempt budget resolves to retry", () => {
    expect(resolveFailure(step(), 1)).toEqual({ action: "retry" });
    expect(resolveFailure(step(), 2)).toEqual({ action: "retry" });
  });

  test("a failure at the attempt budget resolves to the rewind directive verbatim", () => {
    const failing = step({ onFail: { action: "rewind", to: "plan" } });
    expect(resolveFailure(failing, 3)).toEqual({ action: "rewind", to: "plan" });
  });

  test("a failure at the attempt budget resolves to the skip directive verbatim", () => {
    const failing = step({ onFail: { action: "skip" } });
    expect(resolveFailure(failing, 3)).toEqual({ action: "skip" });
  });

  test("a failure at the attempt budget resolves to the escalate directive verbatim", () => {
    expect(resolveFailure(step(), 3)).toEqual({ action: "escalate" });
  });

  test("with maxAttempts 1 the first failure already resolves to onFail", () => {
    const singleShot = step({ maxAttempts: 1, onFail: { action: "skip" } });
    expect(resolveFailure(singleShot, 1)).toEqual({ action: "skip" });
  });
});

describe("validateRunPolicy", () => {
  test("a valid sequence with a backward rewind passes", () => {
    const steps = [
      step({ id: "plan" }),
      step({ id: "code", onFail: { action: "rewind", to: "plan" } }),
    ];
    expect(validateWith(steps)).not.toThrow();
  });

  test("an empty step sequence is rejected", () => {
    expect(validateWith([])).toThrow(FailurePolicyValidationError);
  });

  test("a duplicate step id is rejected", () => {
    expect(validateWith([step({ id: "code" }), step({ id: "code" })])).toThrow(
      FailurePolicyValidationError,
    );
  });

  test("an empty step id is rejected", () => {
    expect(validateWith([step({ id: "" })])).toThrow(FailurePolicyValidationError);
  });

  test("maxAttempts of 0 is rejected", () => {
    expect(validateWith([step({ maxAttempts: 0 })])).toThrow(FailurePolicyValidationError);
  });

  test("non-integer maxAttempts is rejected", () => {
    expect(validateWith([step({ maxAttempts: 1.5 })])).toThrow(FailurePolicyValidationError);
  });

  test("a rewind to an unknown step is rejected", () => {
    expect(validateWith([step({ onFail: { action: "rewind", to: "ghost" } })])).toThrow(
      FailurePolicyValidationError,
    );
  });

  test("a rewind to the step itself is rejected", () => {
    expect(validateWith([step({ id: "code", onFail: { action: "rewind", to: "code" } })])).toThrow(
      FailurePolicyValidationError,
    );
  });

  test("a forward rewind is rejected", () => {
    const steps = [
      step({ id: "plan", onFail: { action: "rewind", to: "code" } }),
      step({ id: "code" }),
    ];
    expect(validateWith(steps)).toThrow(FailurePolicyValidationError);
  });

  test("maxIterations of 0 is rejected", () => {
    expect(validateWith([step()], 0)).toThrow(FailurePolicyValidationError);
  });

  test("non-integer maxIterations is rejected", () => {
    expect(validateWith([step()], 2.5)).toThrow(FailurePolicyValidationError);
  });
});

const rejectedStepIds: ReadonlyArray<readonly [string, string]> = [
  ["a space", "plan code"],
  ["a slash", "steps/code"],
  ["an uppercase letter", "Code"],
  ["a leading dash", "-code"],
  ["a newline", "code\nreview"],
  ["an escape character", String.fromCharCode(0x1b) + "code"],
  ["65 characters", "a".repeat(65)],
];

describe("step id grammar", () => {
  test("a 64-character step id is accepted", () => {
    expect(validateWith([step({ id: "a".repeat(64) })])).not.toThrow();
  });

  for (const [reason, stepId] of rejectedStepIds) {
    test(`a step id with ${reason} is rejected`, () => {
      expect(validateWith([step({ id: stepId })])).toThrow(FailurePolicyValidationError);
    });
  }
});
