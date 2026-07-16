import { describe, expect, test } from "bun:test";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import { applyStepResult, initialRun } from "./reducer";
import type { RunDefinition } from "./reducer";
import { renderCurrentDirective } from "./run-directives";
import type { ReadableRun } from "./run-events";

const GREEN: DoneWhenCriterion[] = [{ kind: "executable", description: "green", command: "true" }];

function phase(id: string, deps: string[] = []): PhaseDocument {
  return {
    id,
    deps,
    agentRole: "coder",
    description: `work on ${id}`,
    tasks: ["do the work"],
    doneWhen: GREEN,
    knowledge: [],
  };
}

function definitionOf(...phases: PhaseDocument[]): RunDefinition {
  return {
    graph: buildPhaseGraph(phases),
    steps: [{ id: "implement", maxAttempts: 1, onFail: { action: "escalate" } }],
    maxIterations: 10,
  };
}

function activeRunFrom(definition: RunDefinition): ReadableRun {
  return {
    kind: "restored",
    runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    branch: "main",
    definition,
    retrieval: { recallBudget: 2000, recallAnchors: {} },
    run: initialRun(definition),
    startedTs: "2026-07-06T10:00:00.000Z",
    lastFailedGates: null,
  };
}

// A fresh run's pending directive is the first phase's recall, which renders as a phase boundary.
describe("renderCurrentDirective phase boundary", () => {
  test("the boundary names the next phase and carries the staged-note count", () => {
    const definition = definitionOf(phase("phase-one"));
    const active = activeRunFrom(definition);

    const rendered = renderCurrentDirective(active, 3);

    expect(rendered.split("\n")[0]).toBe(
      'PHASE BOUNDARY: the previous phase is closed and phase "phase-one" is next and ready.',
    );
    expect(rendered.split("\n")).toContain("Staging queue: 3 note(s) awaiting human review.");
    expect(rendered).toContain('Call workflow_step { run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }');
  });

  test("an empty staging queue renders zero, so the caller can fly on without a staging_list call", () => {
    const active = activeRunFrom(definitionOf(phase("phase-one")));

    const rendered = renderCurrentDirective(active, 0);

    expect(rendered.split("\n")).toContain("Staging queue: 0 note(s) awaiting human review.");
  });

  test("a mid-run boundary (second phase ready) carries the count the same way", () => {
    const definition = definitionOf(phase("phase-one"), phase("phase-two", ["phase-one"]));
    const active = activeRunFrom(definition);
    active.run = applyStepResult(active.run, definition, { kind: "recall", phaseId: "phase-one" });
    active.run = applyStepResult(active.run, definition, {
      kind: "execute_step",
      phaseId: "phase-one",
      stepId: "implement",
      outcome: "success",
    });
    active.run = applyStepResult(active.run, definition, { kind: "harvest", phaseId: "phase-one" });

    const rendered = renderCurrentDirective(active, 2);

    expect(rendered).toContain('phase "phase-two" is next and ready');
    expect(rendered.split("\n")).toContain("Staging queue: 2 note(s) awaiting human review.");
  });
});
