import { describe, expect, test } from "bun:test";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import { applyStepResult, initialRun } from "./reducer";
import type { RunDefinition } from "./reducer";
import { HARVEST_BODY_LIMIT_RULE } from "./harvest-artifacts";
import { INCONCLUSIVE_DIRECTIVE_HEADER, renderCurrentDirective } from "./run-directives";
import type { ReadableRun } from "./run-events";

const GREEN: DoneWhenCriterion[] = [
  { kind: "executable", description: "green", command: "true", timeoutSeconds: null },
];

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
    retrieval: { recallBudget: 2000, recallAnchors: {}, recallDomains: {} },
    run: initialRun(definition),
    startedTs: "2026-07-06T10:00:00.000Z",
    lastActivityTs: "2026-07-06T10:00:00.000Z",
    failedGatesHistory: [],
    lastInconclusiveGate: null,
    bundleNotesByPhase: {},
  };
}

function retryingDefinition(...phases: PhaseDocument[]): RunDefinition {
  return {
    graph: buildPhaseGraph(phases),
    steps: [{ id: "implement", maxAttempts: 3, onFail: { action: "escalate" } }],
    maxIterations: 10,
  };
}

function failedRecord(attempt: number, criterion: string, remark: string) {
  return {
    phaseId: "phase-one",
    stepId: "implement",
    attempt,
    failRemarks: [{ criterionDescription: criterion, remarks: [remark] }],
  };
}

function failOnce(active: ReadableRun): void {
  active.run = applyStepResult(active.run, active.definition, {
    kind: "execute_step",
    phaseId: "phase-one",
    stepId: "implement",
    outcome: "failure",
  });
}

describe("renderCurrentDirective final-step gate limits", () => {
  test("every executable criterion names its effective limit, the default included", () => {
    const limitedPhase: PhaseDocument = {
      ...phase("phase-one"),
      doneWhen: [
        ...GREEN,
        { kind: "executable", description: "heavy suite", command: "bun test", timeoutSeconds: 900 },
      ],
    };
    const active = activeRunFrom(definitionOf(limitedPhase));
    active.run = applyStepResult(active.run, active.definition, { kind: "recall", phaseId: "phase-one" });

    const lines = renderCurrentDirective(active, 0).split("\n");

    expect(lines).toContain("- [executable] green (command: true; limit 300 s)");
    expect(lines).toContain("- [executable] heavy suite (command: bun test; limit 900 s)");
  });
});

describe("renderCurrentDirective harvest", () => {
  test("the harvest directive names the body limit before the agent submits", () => {
    const active = activeRunFrom(definitionOf(phase("phase-one")));
    active.run = applyStepResult(active.run, active.definition, { kind: "recall", phaseId: "phase-one" });
    active.run = applyStepResult(active.run, active.definition, {
      kind: "execute_step",
      phaseId: "phase-one",
      stepId: "implement",
      outcome: "success",
    });

    const lines = renderCurrentDirective(active, 0).split("\n");

    expect(lines[0]).toBe("DIRECTIVE: harvest");
    expect(lines).toContain(`Limit: ${HARVEST_BODY_LIMIT_RULE}.`);
  });
});

describe("renderCurrentDirective after an inconclusive gate run", () => {
  function reRunOnce(): ReadableRun {
    const active = activeRunFrom(retryingDefinition(phase("phase-one")));
    active.run = applyStepResult(active.run, active.definition, { kind: "recall", phaseId: "phase-one" });
    active.run = applyStepResult(active.run, active.definition, {
      kind: "execute_step",
      phaseId: "phase-one",
      stepId: "implement",
      outcome: "inconclusive",
    });
    return active;
  }

  const TIMED_OUT = [{ description: "heavy suite", durationMs: 312_400, timeoutSeconds: 300 }];

  function recordOfAttempt(attempt: number) {
    return { phaseId: "phase-one", stepId: "implement", attempt, timedOut: TIMED_OUT };
  }

  test("the re-issued attempt names what timed out, its duration, its limit and the way forward", () => {
    const active = reRunOnce();
    active.lastInconclusiveGate = recordOfAttempt(1);

    const lines = renderCurrentDirective(active, 0).split("\n");

    expect(lines).toContain("attempt: 1");
    expect(lines).toContain(`${INCONCLUSIVE_DIRECTIVE_HEADER}; environment re-runs left: 1.`);
    expect(lines).toContain("- [heavy suite] timed out after 312.4 s (limit 300 s)");
    expect(lines).toContain(
      "Check the machine's load (another build, a cold compile) and resubmit success with THIS attempt to " +
        "re-run the gates. If the command honestly needs longer, raise its timeout=<N>s fence in the spec: " +
        "the run's definition is frozen at workflow_start, so a new limit takes a new run.",
    );
  });

  test("a record of another attempt renders nothing", () => {
    const active = reRunOnce();
    active.lastInconclusiveGate = recordOfAttempt(2);

    expect(renderCurrentDirective(active, 0)).not.toContain(INCONCLUSIVE_DIRECTIVE_HEADER);
  });
});

// The retry directive replays the WHOLE failed-gates history, ascending by attempt, each block
// under its own provenance header — a remark from attempt 1 must survive attempt 2's failure, or
// the rework fixes the newest complaint while re-breaking what attempt 1 already cured.
describe("renderCurrentDirective failed-review history", () => {
  test("the attempt-3 retry carries both failed attempts' remarks in attempt order", () => {
    const active = activeRunFrom(retryingDefinition(phase("phase-one")));
    active.run = applyStepResult(active.run, active.definition, { kind: "recall", phaseId: "phase-one" });
    failOnce(active);
    failOnce(active);
    active.failedGatesHistory = [
      failedRecord(1, "review approves", "the parser drops the last line"),
      failedRecord(2, "standards hold", "the helper name abbreviates"),
    ];

    const rendered = renderCurrentDirective(active, 0);

    expect(rendered).toContain("attempt: 3");
    expect(rendered).toContain("review remarks from failed attempt 1:");
    expect(rendered).toContain("- [review approves] the parser drops the last line");
    expect(rendered).toContain("review remarks from failed attempt 2:");
    expect(rendered).toContain("- [standards hold] the helper name abbreviates");
    expect(rendered.indexOf("failed attempt 1")).toBeLessThan(rendered.indexOf("failed attempt 2"));
  });

  test("a criterion cured in attempt 2 keeps its attempt-1 remark rendered as history", () => {
    const active = activeRunFrom(retryingDefinition(phase("phase-one")));
    active.run = applyStepResult(active.run, active.definition, { kind: "recall", phaseId: "phase-one" });
    failOnce(active);
    failOnce(active);
    // Attempt 2's record names only the OTHER criterion: "review approves" passed there, yet its
    // attempt-1 remark must still render — that is the do-not-re-break contract.
    active.failedGatesHistory = [
      failedRecord(1, "review approves", "the parser drops the last line"),
      failedRecord(2, "standards hold", "the helper name abbreviates"),
    ];

    const rendered = renderCurrentDirective(active, 0);

    expect(rendered).toContain("- [review approves] the parser drops the last line");
  });

  test("a history whose last record does not precede the pending attempt renders nothing (rewind)", () => {
    const active = activeRunFrom(retryingDefinition(phase("phase-one")));
    active.run = applyStepResult(active.run, active.definition, { kind: "recall", phaseId: "phase-one" });
    // Pending attempt is 1 (as after a rewind's counter reset); a stale record cannot match.
    active.failedGatesHistory = [failedRecord(1, "review approves", "stale remark")];

    const rendered = renderCurrentDirective(active, 0);

    expect(rendered).toContain("attempt: 1");
    expect(rendered).not.toContain("review remarks");
  });
});

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
