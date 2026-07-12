import { describe, expect, test } from "bun:test";
import { buildPhaseGraph } from "./phase-graph";
import type { PhaseGraph } from "./phase-graph";
import { FailurePolicyValidationError } from "./failure-policy";
import type { StepDefinition } from "./failure-policy";
import { WorkflowStateError, applyStepResult, initialRun, reduce } from "./reducer";
import type { ExecuteStepDirective, RunDefinition, StepResult, WorkflowRun } from "./reducer";
import type { PhaseDocument } from "./phase-document";

function phase(id: string, deps: string[] = [], agentRole = "coder"): PhaseDocument {
  return {
    id,
    deps,
    agentRole,
    description: "",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "work is verified", command: "bun test" }],
  };
}

function linearGraph(): PhaseGraph {
  return buildPhaseGraph([phase("alpha", [], "planner"), phase("beta", ["alpha"], "builder")]);
}

function diamondGraph(): PhaseGraph {
  return buildPhaseGraph([phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])]);
}

function steps(...stepIds: string[]): StepDefinition[] {
  return stepIds.map((stepId) => ({ id: stepId, maxAttempts: 1, onFail: { action: "escalate" } }));
}

function definitionOf(
  graph: PhaseGraph,
  stepDefinitions: StepDefinition[],
  maxIterations = 100,
): RunDefinition {
  return { graph, steps: stepDefinitions, maxIterations };
}

function soloDefinition(stepDefinitions: StepDefinition[], maxIterations = 100): RunDefinition {
  return definitionOf(buildPhaseGraph([phase("solo")]), stepDefinitions, maxIterations);
}

function success(phaseId: string, stepId: string): StepResult {
  return { phaseId, stepId, outcome: "success" };
}

function failure(phaseId: string, stepId: string): StepResult {
  return { phaseId, stepId, outcome: "failure" };
}

function drive(definition: RunDefinition, results: StepResult[]): WorkflowRun {
  let run = initialRun(definition);
  for (const result of results) {
    run = applyStepResult(run, definition, result);
  }
  return run;
}

function driveToEnd(definition: RunDefinition): {
  directives: ExecuteStepDirective[];
  run: WorkflowRun;
} {
  let run = initialRun(definition);
  const directives: ExecuteStepDirective[] = [];
  while (run.status === "running") {
    const directive = reduce(run, definition);
    if (directive.kind !== "execute_step") {
      throw new Error(`a running run must dispense execute_step, got ${directive.kind}`);
    }
    directives.push(directive);
    run = applyStepResult(run, definition, success(directive.phaseId, directive.stepId));
  }
  return { directives, run };
}

describe("initialRun", () => {
  test("starts running with pending phases and zeroed counters", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    expect(initialRun(definition)).toEqual({
      status: "running",
      phaseStatuses: { alpha: "pending", beta: "pending" },
      activePhaseId: null,
      stepIndex: 0,
      stepAttempts: [0, 0],
      iterationsUsed: 0,
      failureReason: null,
      escalation: null,
    });
  });

  test("rejects an invalid run policy", () => {
    expect(() => initialRun(definitionOf(linearGraph(), steps()))).toThrow(
      FailurePolicyValidationError,
    );
    expect(() => initialRun(definitionOf(linearGraph(), steps("plan"), 0))).toThrow(
      FailurePolicyValidationError,
    );
  });
});

describe("linear run", () => {
  test("dispenses the exact directive sequence to run_complete", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    const { directives, run } = driveToEnd(definition);
    expect(directives).toEqual([
      { kind: "execute_step", phaseId: "alpha", stepId: "plan", agentRole: "planner", attempt: 1 },
      { kind: "execute_step", phaseId: "alpha", stepId: "code", agentRole: "planner", attempt: 1 },
      { kind: "execute_step", phaseId: "beta", stepId: "plan", agentRole: "builder", attempt: 1 },
      { kind: "execute_step", phaseId: "beta", stepId: "code", agentRole: "builder", attempt: 1 },
    ]);
    expect(run.status).toBe("complete");
    expect(run.phaseStatuses).toEqual({ alpha: "closed", beta: "closed" });
    expect(reduce(run, definition)).toEqual({ kind: "run_complete" });
  });
});

describe("diamond run", () => {
  test("closes phases in ascending-id order between the branches", () => {
    const definition = definitionOf(diamondGraph(), steps("work"));
    const { directives, run } = driveToEnd(definition);
    expect(directives.map((directive) => directive.phaseId)).toEqual(["a", "b", "c", "d"]);
    expect(run.status).toBe("complete");
  });

  test("every dispensed step has all phase dependencies closed at dispense time", () => {
    const definition = definitionOf(diamondGraph(), steps("work"));
    let run = initialRun(definition);
    while (run.status === "running") {
      const directive = reduce(run, definition);
      if (directive.kind !== "execute_step") {
        throw new Error(`a running run must dispense execute_step, got ${directive.kind}`);
      }
      const dispensedPhase = definition.graph.phases[directive.phaseId];
      if (dispensedPhase === undefined) {
        throw new Error(`dispensed unknown phase ${directive.phaseId}`);
      }
      for (const dependencyId of dispensedPhase.deps) {
        expect(run.phaseStatuses[dependencyId]).toBe("closed");
      }
      run = applyStepResult(run, definition, success(directive.phaseId, directive.stepId));
    }
    expect(run.status).toBe("complete");
  });
});

describe("failure handling", () => {
  test("a failure under the attempt budget re-dispenses the same step as attempt 2", () => {
    const definition = soloDefinition([{ id: "code", maxAttempts: 2, onFail: { action: "escalate" } }]);
    let run = initialRun(definition);
    run = applyStepResult(run, definition, failure("solo", "code"));
    expect(run.status).toBe("running");
    expect(reduce(run, definition)).toEqual({
      kind: "execute_step",
      phaseId: "solo",
      stepId: "code",
      agentRole: "coder",
      attempt: 2,
    });
    run = applyStepResult(run, definition, success("solo", "code"));
    expect(run.status).toBe("complete");
  });

  test("a rewind moves the cursor back and resets attempts from the target onward", () => {
    const definition = soloDefinition([
      { id: "code", maxAttempts: 2, onFail: { action: "escalate" } },
      { id: "review", maxAttempts: 1, onFail: { action: "rewind", to: "code" } },
    ]);
    const run = drive(definition, [
      failure("solo", "code"),
      success("solo", "code"),
      failure("solo", "review"),
    ]);
    expect(run.status).toBe("running");
    expect(run.stepIndex).toBe(0);
    expect(run.stepAttempts).toEqual([0, 0]);
    expect(reduce(run, definition)).toEqual({
      kind: "execute_step",
      phaseId: "solo",
      stepId: "code",
      agentRole: "coder",
      attempt: 1,
    });
  });

  test("a rewind preserves attempts before the target and resets from the target onward", () => {
    const definition = soloDefinition([
      { id: "plan", maxAttempts: 2, onFail: { action: "escalate" } },
      { id: "code", maxAttempts: 2, onFail: { action: "escalate" } },
      { id: "review", maxAttempts: 1, onFail: { action: "rewind", to: "code" } },
    ]);
    const run = drive(definition, [
      failure("solo", "plan"),
      success("solo", "plan"),
      failure("solo", "code"),
      success("solo", "code"),
      failure("solo", "review"),
    ]);
    expect(run.status).toBe("running");
    expect(run.stepIndex).toBe(1);
    expect(run.stepAttempts).toEqual([1, 0, 0]);
  });

  test("a rewind resets the rewinding step's own attempt counter", () => {
    const definition = soloDefinition([
      { id: "plan", maxAttempts: 1, onFail: { action: "escalate" } },
      { id: "code", maxAttempts: 1, onFail: { action: "escalate" } },
      { id: "review", maxAttempts: 2, onFail: { action: "rewind", to: "code" } },
    ]);
    const run = drive(definition, [
      success("solo", "plan"),
      success("solo", "code"),
      failure("solo", "review"),
      failure("solo", "review"),
    ]);
    expect(run.status).toBe("running");
    expect(run.stepIndex).toBe(1);
    expect(run.stepAttempts).toEqual([0, 0, 0]);
  });

  test("closing a phase resets attempt budgets for the next phase", () => {
    const definition = definitionOf(linearGraph(), [
      { id: "code", maxAttempts: 2, onFail: { action: "escalate" } },
    ]);
    const run = drive(definition, [failure("alpha", "code"), success("alpha", "code")]);
    expect(run.status).toBe("running");
    expect(reduce(run, definition)).toEqual({
      kind: "execute_step",
      phaseId: "beta",
      stepId: "code",
      agentRole: "builder",
      attempt: 1,
    });
  });

  test("a skip on the last step closes the phase and completes the run", () => {
    const definition = soloDefinition([{ id: "code", maxAttempts: 1, onFail: { action: "skip" } }]);
    const run = drive(definition, [failure("solo", "code")]);
    expect(run.status).toBe("complete");
    expect(run.phaseStatuses).toEqual({ solo: "closed" });
    expect(reduce(run, definition)).toEqual({ kind: "run_complete" });
  });

  test("a skip on a middle step advances to the next step", () => {
    const definition = soloDefinition([
      { id: "code", maxAttempts: 1, onFail: { action: "skip" } },
      { id: "review", maxAttempts: 1, onFail: { action: "escalate" } },
    ]);
    const run = drive(definition, [failure("solo", "code")]);
    expect(run.status).toBe("running");
    expect(reduce(run, definition)).toEqual({
      kind: "execute_step",
      phaseId: "solo",
      stepId: "review",
      agentRole: "coder",
      attempt: 1,
    });
  });
});

describe("escalation", () => {
  test("an exhausted escalate step terminates the run and rejects further results", () => {
    const definition = soloDefinition(steps("code"));
    const run = drive(definition, [failure("solo", "code")]);
    expect(run.status).toBe("escalated");
    expect(run.escalation).toEqual({
      phaseId: "solo",
      stepId: "code",
      reason: "retry_budget_exhausted",
    });
    expect(reduce(run, definition)).toEqual({
      kind: "escalate",
      phaseId: "solo",
      stepId: "code",
      reason: "retry_budget_exhausted",
    });
    expect(() => applyStepResult(run, definition, success("solo", "code"))).toThrow(
      WorkflowStateError,
    );
  });

  test("an escalation on the iteration that exhausts the budget wins over failure", () => {
    const definition = soloDefinition(steps("code"), 1);
    const run = drive(definition, [failure("solo", "code")]);
    expect(run.status).toBe("escalated");
    expect(run.failureReason).toBeNull();
  });
});

describe("result validation", () => {
  test("a result for the wrong phase is rejected", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    const run = initialRun(definition);
    expect(() => applyStepResult(run, definition, success("beta", "plan"))).toThrow(
      WorkflowStateError,
    );
  });

  test("a result for the wrong step is rejected", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    const run = initialRun(definition);
    expect(() => applyStepResult(run, definition, success("alpha", "code"))).toThrow(
      WorkflowStateError,
    );
  });

  test("a result applied to a complete run is rejected", () => {
    const definition = soloDefinition(steps("code"));
    const run = drive(definition, [success("solo", "code")]);
    expect(run.status).toBe("complete");
    expect(() => applyStepResult(run, definition, success("solo", "code"))).toThrow(
      WorkflowStateError,
    );
  });
});

describe("iteration budget", () => {
  test("completing exactly at maxIterations is complete, not failed", () => {
    const definition = soloDefinition(steps("plan", "code"), 2);
    const run = drive(definition, [success("solo", "plan"), success("solo", "code")]);
    expect(run.status).toBe("complete");
    expect(run.failureReason).toBeNull();
  });

  test("exhausting the budget mid-work fails the run", () => {
    const definition = soloDefinition(steps("plan", "code"), 1);
    const run = drive(definition, [success("solo", "plan")]);
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("max_iterations_exhausted");
    expect(reduce(run, definition)).toEqual({
      kind: "run_failed",
      reason: "max_iterations_exhausted",
    });
    expect(() => applyStepResult(run, definition, success("solo", "code"))).toThrow(
      WorkflowStateError,
    );
  });

  test("failed attempts consume the iteration budget", () => {
    const definition = soloDefinition(
      [{ id: "code", maxAttempts: 5, onFail: { action: "escalate" } }],
      2,
    );
    const run = drive(definition, [failure("solo", "code"), failure("solo", "code")]);
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("max_iterations_exhausted");
  });
});

describe("run state", () => {
  test("a mid-run state survives a JSON round-trip", () => {
    const definition = soloDefinition([
      { id: "code", maxAttempts: 3, onFail: { action: "escalate" } },
      { id: "review", maxAttempts: 1, onFail: { action: "escalate" } },
    ]);
    const run = drive(definition, [failure("solo", "code"), failure("solo", "code")]);
    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
  });
});

describe("determinism", () => {
  test("reduce is byte-stable across repeated calls on the same state", () => {
    const definition = definitionOf(diamondGraph(), steps("work"));
    const run = drive(definition, [success("a", "work")]);
    const first = reduce(run, definition);
    const second = reduce(run, definition);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("applyStepResult is byte-stable and does not mutate its input", () => {
    const definition = definitionOf(diamondGraph(), steps("work"));
    const run = drive(definition, [success("a", "work")]);
    const snapshot = JSON.stringify(run);
    const first = applyStepResult(run, definition, success("b", "work"));
    const second = applyStepResult(run, definition, success("b", "work"));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(run)).toBe(snapshot);
  });
});
