import { describe, expect, test } from "bun:test";
import { buildPhaseGraph } from "./phase-graph";
import type { PhaseGraph } from "./phase-graph";
import { FailurePolicyValidationError } from "./failure-policy";
import type { StepDefinition } from "./failure-policy";
import { WorkflowStateError, applyStepResult, initialRun, reduce } from "./reducer";
import type { Directive, RunDefinition, StepResult, WorkflowRun } from "./reducer";
import { parsePhaseDocument } from "./phase-document";
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

// The default synthetic phase() carries an empty description and a single task bullet, so an
// execute_step directive derived from it mirrors those. The self-sufficiency specs below instead
// parse a REAL serialized phase document (non-empty description + multiple task bullets) so the
// "directive carries the work" invariant cannot pass vacuously on empty content.
function executeStep(phaseId: string, stepId: string, agentRole: string, attempt: number): Directive {
  return { kind: "execute_step", phaseId, stepId, agentRole, description: "", tasks: ["do the work"], attempt };
}

const REAL_PHASE_TEXT = [
  "---",
  'id: "wf-migration"',
  "deps: []",
  'agent-role: "coder"',
  "---",
  "Dogfood mneme onto its own workflow engine.",
  "",
  "## Tasks",
  "- Persist phase files into the project",
  "- Apply the knowledge routing to CLAUDE.md and docs",
  "- Run the dogfood loop end to end",
  "",
  "## Done-when",
  "- the phase verification suite passes",
  "```",
  "bun test",
  "```",
  "",
].join("\n");

const REAL_PHASE_TASKS = [
  "Persist phase files into the project",
  "Apply the knowledge routing to CLAUDE.md and docs",
  "Run the dogfood loop end to end",
];

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
  return { kind: "execute_step", phaseId, stepId, outcome: "success" };
}

function failure(phaseId: string, stepId: string): StepResult {
  return { kind: "execute_step", phaseId, stepId, outcome: "failure" };
}

function recallDone(phaseId: string): StepResult {
  return { kind: "recall", phaseId };
}

function harvestDone(phaseId: string): StepResult {
  return { kind: "harvest", phaseId };
}

// Auto-submits the recall/harvest completions the lifecycle dispenses around the queued
// execute-step results, so specs read as sequences of agent outcomes.
function drive(definition: RunDefinition, results: StepResult[]): WorkflowRun {
  let run = initialRun(definition);
  for (const result of results) {
    run = flushLifecycleDirectives(run, definition);
    run = applyStepResult(run, definition, result);
  }
  return flushLifecycleDirectives(run, definition);
}

function flushLifecycleDirectives(run: WorkflowRun, definition: RunDefinition): WorkflowRun {
  while (run.status === "running") {
    const directive = reduce(run, definition);
    if (directive.kind === "recall") {
      run = applyStepResult(run, definition, recallDone(directive.phaseId));
    } else if (directive.kind === "harvest") {
      run = applyStepResult(run, definition, harvestDone(directive.phaseId));
    } else {
      return run;
    }
  }
  return run;
}

function driveToEnd(definition: RunDefinition): { directives: Directive[]; run: WorkflowRun } {
  let run = initialRun(definition);
  const directives: Directive[] = [];
  while (run.status === "running") {
    const directive = reduce(run, definition);
    directives.push(directive);
    if (directive.kind === "recall") {
      run = applyStepResult(run, definition, recallDone(directive.phaseId));
    } else if (directive.kind === "harvest") {
      run = applyStepResult(run, definition, harvestDone(directive.phaseId));
    } else if (directive.kind === "execute_step") {
      run = applyStepResult(run, definition, success(directive.phaseId, directive.stepId));
    } else {
      throw new Error(`a running run must dispense a work directive, got ${directive.kind}`);
    }
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
      { kind: "recall", phaseId: "alpha" },
      executeStep("alpha", "plan", "planner", 1),
      executeStep("alpha", "code", "planner", 1),
      { kind: "harvest", phaseId: "alpha" },
      { kind: "recall", phaseId: "beta" },
      executeStep("beta", "plan", "builder", 1),
      executeStep("beta", "code", "builder", 1),
      { kind: "harvest", phaseId: "beta" },
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
    const executed = directives.filter((directive) => directive.kind === "execute_step");
    expect(executed.map((directive) => directive.phaseId)).toEqual(["a", "b", "c", "d"]);
    expect(run.status).toBe("complete");
  });

  test("every dispensed step has all phase dependencies closed at dispense time", () => {
    const definition = definitionOf(diamondGraph(), steps("work"));
    let run = initialRun(definition);
    while (run.status === "running") {
      const directive = reduce(run, definition);
      if (directive.kind === "recall") {
        run = applyStepResult(run, definition, recallDone(directive.phaseId));
        continue;
      }
      if (directive.kind === "harvest") {
        run = applyStepResult(run, definition, harvestDone(directive.phaseId));
        continue;
      }
      if (directive.kind !== "execute_step") {
        throw new Error(`a running run must dispense a work directive, got ${directive.kind}`);
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

describe("memory lifecycle", () => {
  test("recall is dispensed before any execute_step", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    expect(reduce(initialRun(definition), definition)).toEqual({ kind: "recall", phaseId: "alpha" });
  });

  test("an execute_step result while recall is expected is rejected", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    expect(() => applyStepResult(initialRun(definition), definition, success("alpha", "plan"))).toThrow(
      WorkflowStateError,
    );
  });

  test("a recall completion for the wrong phase is rejected", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    expect(() => applyStepResult(initialRun(definition), definition, recallDone("beta"))).toThrow(
      WorkflowStateError,
    );
  });

  test("a recall completion opens the phase without consuming an iteration", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    const run = applyStepResult(initialRun(definition), definition, recallDone("alpha"));
    expect(run.activePhaseId).toBe("alpha");
    expect(run.iterationsUsed).toBe(0);
    expect(reduce(run, definition)).toEqual(executeStep("alpha", "plan", "planner", 1));
  });

  test("harvest is dispensed only after final-step success and consumes no iteration", () => {
    const definition = soloDefinition(steps("plan", "code"));
    let run = applyStepResult(initialRun(definition), definition, recallDone("solo"));
    run = applyStepResult(run, definition, success("solo", "plan"));
    expect(reduce(run, definition).kind).toBe("execute_step");
    run = applyStepResult(run, definition, success("solo", "code"));
    expect(run.phaseStatuses["solo"]).toBe("pending");
    expect(reduce(run, definition)).toEqual({ kind: "harvest", phaseId: "solo" });
    run = applyStepResult(run, definition, harvestDone("solo"));
    expect(run.status).toBe("complete");
    expect(run.iterationsUsed).toBe(2);
  });

  test("a harvest result while an execute_step is expected is rejected", () => {
    const definition = soloDefinition(steps("code"));
    const run = applyStepResult(initialRun(definition), definition, recallDone("solo"));
    expect(() => applyStepResult(run, definition, harvestDone("solo"))).toThrow(WorkflowStateError);
  });

  test("exhaustion with a pending harvest still accepts the harvest, then fails before the next phase", () => {
    const definition = definitionOf(linearGraph(), steps("code"), 1);
    let run = applyStepResult(initialRun(definition), definition, recallDone("alpha"));
    run = applyStepResult(run, definition, success("alpha", "code"));
    expect(run.status).toBe("running");
    expect(reduce(run, definition)).toEqual({ kind: "harvest", phaseId: "alpha" });
    run = applyStepResult(run, definition, harvestDone("alpha"));
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("max_iterations_exhausted");
    expect(run.phaseStatuses["alpha"]).toBe("closed");
  });
});

describe("execute_step self-sufficiency", () => {
  test("carries the phase intent and enumerated tasks from a real phase document", () => {
    const definition = definitionOf(
      buildPhaseGraph([parsePhaseDocument(REAL_PHASE_TEXT)]),
      steps("implement"),
    );
    const opened = applyStepResult(initialRun(definition), definition, recallDone("wf-migration"));
    expect(reduce(opened, definition)).toEqual({
      kind: "execute_step",
      phaseId: "wf-migration",
      stepId: "implement",
      agentRole: "coder",
      description: "Dogfood mneme onto its own workflow engine.",
      tasks: REAL_PHASE_TASKS,
      attempt: 1,
    });
  });

  test("a run restored by folding results (no re-supplied phase document) still carries the tasks", () => {
    const definition = definitionOf(
      buildPhaseGraph([parsePhaseDocument(REAL_PHASE_TEXT)]),
      steps("implement"),
    );
    // Resume without re-calling workflow_start: rebuild the run purely by folding the logged
    // StepResults through applyStepResult (the documented restore), then reduce. The directive's
    // work must come from the (log-derived) definition, never from session-held phase text.
    const restored = [recallDone("wf-migration")].reduce(
      (run, result) => applyStepResult(run, definition, result),
      initialRun(definition),
    );
    const directive = reduce(restored, definition);
    if (directive.kind !== "execute_step") {
      throw new Error(`expected execute_step after resume, got ${directive.kind}`);
    }
    expect(directive.tasks).toEqual(REAL_PHASE_TASKS);
    expect(directive.tasks.length).toBeGreaterThan(0);
  });
});

describe("failure handling", () => {
  test("a failure under the attempt budget re-dispenses the same step as attempt 2", () => {
    const definition = soloDefinition([{ id: "code", maxAttempts: 2, onFail: { action: "escalate" } }]);
    let run = applyStepResult(initialRun(definition), definition, recallDone("solo"));
    run = applyStepResult(run, definition, failure("solo", "code"));
    expect(run.status).toBe("running");
    expect(reduce(run, definition)).toEqual(executeStep("solo", "code", "coder", 2));
    run = applyStepResult(run, definition, success("solo", "code"));
    run = applyStepResult(run, definition, harvestDone("solo"));
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
    expect(reduce(run, definition)).toEqual(executeStep("solo", "code", "coder", 1));
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
    expect(reduce(run, definition)).toEqual(executeStep("beta", "code", "builder", 1));
  });

  test("a skip on the last step closes the phase without dispensing harvest", () => {
    const definition = soloDefinition([{ id: "code", maxAttempts: 1, onFail: { action: "skip" } }]);
    let run = applyStepResult(initialRun(definition), definition, recallDone("solo"));
    run = applyStepResult(run, definition, failure("solo", "code"));
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
    expect(reduce(run, definition)).toEqual(executeStep("solo", "review", "coder", 1));
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
    const run = applyStepResult(initialRun(definition), definition, recallDone("alpha"));
    expect(() => applyStepResult(run, definition, success("beta", "plan"))).toThrow(
      WorkflowStateError,
    );
  });

  test("a result for the wrong step is rejected", () => {
    const definition = definitionOf(linearGraph(), steps("plan", "code"));
    const run = applyStepResult(initialRun(definition), definition, recallDone("alpha"));
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
