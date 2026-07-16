import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE_COMMAND_TIMEOUT_MS,
  GateCommandFormatError,
  GateInputError,
  formatGateReport,
  runPhaseGates,
  stepResultFromGateReport,
  tokenizeCommand,
} from "./gate-runner";
import type { GateReport, GateRunOptions } from "./gate-runner";
import { buildPhaseGraph } from "./phase-graph";
import { applyStepResult, initialRun, reduce } from "./reducer";
import type { RunDefinition, WorkflowRun } from "./reducer";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";

const FIXTURE_SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ["exit-zero.ts", "process.exit(0);\n"],
  ["exit-one.ts", "process.exit(1);\n"],
  ["sleep.ts", "await Bun.sleep(60_000);\n"],
  ["write-marker.ts", 'import { writeFileSync } from "node:fs";\nwriteFileSync("marker.txt", "written");\n'],
];

const temporaryDirectories: string[] = [];

function makeProjectRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "mneme-gate-fixture-"));
  temporaryDirectories.push(directory);
  for (const [name, contents] of FIXTURE_SCRIPTS) {
    writeFileSync(join(directory, name), contents);
  }
  return directory;
}

let sharedProjectRoot: string;

beforeAll(() => {
  sharedProjectRoot = makeProjectRoot();
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function executable(description: string, command: string): DoneWhenCriterion {
  return { kind: "executable", description, command };
}

function agentJudged(description: string): DoneWhenCriterion {
  return { kind: "agent-judged", description };
}

function optionsFor(projectRoot: string, agentVotes: GateRunOptions["agentVotes"] = []): GateRunOptions {
  return { projectRoot, agentVotes, commandTimeoutMs: 5_000 };
}

describe("runPhaseGates executable criteria", () => {
  test("a command that exits zero passes as exit-zero", async () => {
    const report = await runPhaseGates(
      [executable("command succeeds", "bun exit-zero.ts")],
      optionsFor(sharedProjectRoot),
    );
    expect(report.passed).toBe(true);
    expect(report.executableCount).toBe(1);
    expect(report.agentJudgedCount).toBe(0);
    expect(report.criterionResults).toEqual([
      {
        kind: "executable",
        description: "command succeeds",
        command: "bun exit-zero.ts",
        passed: true,
        reason: "exit-zero",
        exitCode: 0,
      },
    ]);
  }, 15_000);

  test("a command that exits nonzero fails as exit-nonzero", async () => {
    const report = await runPhaseGates(
      [executable("command fails", "bun exit-one.ts")],
      optionsFor(sharedProjectRoot),
    );
    expect(report.passed).toBe(false);
    const [result] = report.criterionResults;
    expect(result).toMatchObject({
      kind: "executable",
      passed: false,
      reason: "exit-nonzero",
      exitCode: 1,
    });
  }, 15_000);

  test("results preserve criterion order and one red fails the whole report", async () => {
    const report = await runPhaseGates(
      [
        executable("first passes", "bun exit-zero.ts"),
        executable("second fails", "bun exit-one.ts"),
        executable("third passes", "bun exit-zero.ts"),
      ],
      optionsFor(sharedProjectRoot),
    );
    expect(report.passed).toBe(false);
    expect(report.executableCount).toBe(3);
    expect(report.agentJudgedCount).toBe(0);
    expect(report.criterionResults.map((result) => result.description)).toEqual([
      "first passes",
      "second fails",
      "third passes",
    ]);
    expect(
      report.criterionResults.map((result) =>
        result.kind === "executable" ? result.reason : "agent-judged",
      ),
    ).toEqual(["exit-zero", "exit-nonzero", "exit-zero"]);
  }, 20_000);

  test("commands run with cwd set to projectRoot", async () => {
    const projectRoot = makeProjectRoot();
    const report = await runPhaseGates(
      [executable("marker is written", "bun write-marker.ts")],
      optionsFor(projectRoot),
    );
    expect(report.passed).toBe(true);
    expect(existsSync(join(projectRoot, "marker.txt"))).toBe(true);
  }, 15_000);
});

describe("runPhaseGates fail-closed executable paths", () => {
  test("a missing binary fails closed as spawn-error without throwing", async () => {
    const report = await runPhaseGates(
      [executable("missing binary", "definitely-not-a-real-binary-xyz run")],
      optionsFor(sharedProjectRoot),
    );
    expect(report.passed).toBe(false);
    expect(report.criterionResults[0]).toMatchObject({
      kind: "executable",
      passed: false,
      reason: "spawn-error",
      exitCode: null,
    });
  }, 15_000);

  test("a quoted command fails closed as malformed-command without throwing", async () => {
    const report = await runPhaseGates(
      [executable("quoted argument", 'bun "exit-zero.ts"')],
      optionsFor(sharedProjectRoot),
    );
    expect(report.passed).toBe(false);
    expect(report.criterionResults[0]).toMatchObject({
      kind: "executable",
      passed: false,
      reason: "malformed-command",
      exitCode: null,
    });
  }, 15_000);

  test("a command exceeding the timeout fails closed as timeout", async () => {
    const report = await runPhaseGates([executable("hangs", "bun sleep.ts")], {
      projectRoot: sharedProjectRoot,
      agentVotes: [],
      commandTimeoutMs: 250,
    });
    expect(report.passed).toBe(false);
    expect(report.criterionResults[0]).toMatchObject({
      kind: "executable",
      passed: false,
      reason: "timeout",
      exitCode: null,
    });
  }, 15_000);

  test("the default per-command timeout is five minutes", () => {
    expect(GATE_COMMAND_TIMEOUT_MS).toBe(300_000);
  });
});

describe("runPhaseGates agent-judged criteria", () => {
  test("a unanimous vote passes and is counted as agent-judged", async () => {
    const report = await runPhaseGates(
      [agentJudged("reviewer approves")],
      optionsFor(sharedProjectRoot, [[{ vote: "pass" }]]),
    );
    expect(report.passed).toBe(true);
    expect(report.executableCount).toBe(0);
    expect(report.agentJudgedCount).toBe(1);
    expect(report.criterionResults[0]).toEqual({
      kind: "agent-judged",
      description: "reviewer approves",
      passed: true,
      votes: [{ vote: "pass" }],
    });
  });

  test("a non-unanimous K=N vote fails closed", async () => {
    const report = await runPhaseGates(
      [agentJudged("reviewer approves")],
      optionsFor(sharedProjectRoot, [[{ vote: "pass" }, { vote: "fail" }]]),
    );
    expect(report.passed).toBe(false);
  });

  test("an empty vote array fails closed", async () => {
    const report = await runPhaseGates(
      [agentJudged("nobody judged")],
      optionsFor(sharedProjectRoot, [[]]),
    );
    expect(report.passed).toBe(false);
  });

  test("a fail vote's remarks survive into the criterion result verbatim", async () => {
    const report = await runPhaseGates(
      [agentJudged("reviewer approves")],
      optionsFor(sharedProjectRoot, [[{ vote: "fail", remarks: "the parser drops the last line" }]]),
    );
    expect(report.passed).toBe(false);
    expect(report.criterionResults[0]).toEqual({
      kind: "agent-judged",
      description: "reviewer approves",
      passed: false,
      votes: [{ vote: "fail", remarks: "the parser drops the last line" }],
    });
  });
});

describe("runPhaseGates mixed documents", () => {
  test("counts both kinds and passes only when every criterion passes", async () => {
    const report = await runPhaseGates(
      [executable("command succeeds", "bun exit-zero.ts"), agentJudged("reviewer approves")],
      optionsFor(sharedProjectRoot, [[{ vote: "pass" }]]),
    );
    expect(report.passed).toBe(true);
    expect(report.executableCount).toBe(1);
    expect(report.agentJudgedCount).toBe(1);
    expect(report.executableCount + report.agentJudgedCount).toBe(report.criterionResults.length);
  }, 15_000);
});

describe("runPhaseGates caller-contract validation", () => {
  test("an empty done-when list is rejected with GateInputError", () => {
    expect(runPhaseGates([], optionsFor(sharedProjectRoot))).rejects.toBeInstanceOf(GateInputError);
  });

  test("too few vote arrays for the agent-judged criteria is rejected", () => {
    expect(
      runPhaseGates([agentJudged("reviewer approves")], optionsFor(sharedProjectRoot, [])),
    ).rejects.toBeInstanceOf(GateInputError);
  });

  test("too many vote arrays for the agent-judged criteria is rejected", () => {
    expect(
      runPhaseGates(
        [executable("command succeeds", "bun exit-zero.ts")],
        optionsFor(sharedProjectRoot, [[{ vote: "pass" }]]),
      ),
    ).rejects.toBeInstanceOf(GateInputError);
  });
});

describe("tokenizeCommand", () => {
  test("splits on runs of spaces", () => {
    expect(tokenizeCommand("bun exit-zero.ts")).toEqual(["bun", "exit-zero.ts"]);
    expect(tokenizeCommand("bun   test   --coverage")).toEqual(["bun", "test", "--coverage"]);
  });

  test("trims surrounding spaces", () => {
    expect(tokenizeCommand("  bun test  ")).toEqual(["bun", "test"]);
  });

  test("splits only on U+0020, so an upstream-guaranteed tab is never a separator", () => {
    expect(tokenizeCommand("bun\ttest")).toEqual(["bun\ttest"]);
  });

  test("rejects a double-quote character", () => {
    expect(() => tokenizeCommand('bun "exit-zero.ts"')).toThrow(GateCommandFormatError);
  });

  test("rejects a single-quote character", () => {
    expect(() => tokenizeCommand("bun 'exit-zero.ts'")).toThrow(GateCommandFormatError);
  });

  test("rejects an empty command", () => {
    expect(() => tokenizeCommand("   ")).toThrow(GateCommandFormatError);
  });

  test("rejects a leading-dash program token", () => {
    expect(() => tokenizeCommand("--help me")).toThrow(GateCommandFormatError);
  });
});

describe("formatGateReport", () => {
  test("renders per-criterion markers and a total-criteria counter line", async () => {
    const report = await runPhaseGates(
      [executable("command succeeds", "bun exit-zero.ts"), agentJudged("reviewer approves")],
      optionsFor(sharedProjectRoot, [[{ vote: "fail" }]]),
    );
    const formatted = formatGateReport(report);
    expect(formatted).toContain("PASS command succeeds [exit-zero]");
    expect(formatted).toContain("FAIL reviewer approves [agent-judged]");
    expect(formatted).toContain("agent-judged verdicts: 1 of 2 criteria");
  }, 15_000);

  test("the counter's total is executableCount plus agentJudgedCount, not the agent-judged count", () => {
    const report: GateReport = {
      passed: false,
      criterionResults: [
        {
          kind: "executable",
          description: "a",
          command: "bun exit-zero.ts",
          passed: true,
          reason: "exit-zero",
          exitCode: 0,
        },
        { kind: "agent-judged", description: "b", passed: false, votes: [{ vote: "fail" }] },
        { kind: "agent-judged", description: "c", passed: true, votes: [{ vote: "pass" }] },
      ],
      executableCount: 1,
      agentJudgedCount: 2,
    };
    expect(formatGateReport(report)).toContain("agent-judged verdicts: 2 of 3 criteria");
  });
});

describe("stepResultFromGateReport", () => {
  const passingReport: GateReport = {
    passed: true,
    criterionResults: [],
    executableCount: 0,
    agentJudgedCount: 0,
  };

  test("a passing report maps to a success step result", () => {
    expect(stepResultFromGateReport("solo", "verify", passingReport)).toEqual({
      kind: "execute_step",
      phaseId: "solo",
      stepId: "verify",
      outcome: "success",
    });
  });

  test("a failing report maps to a failure step result", () => {
    expect(stepResultFromGateReport("solo", "verify", { ...passingReport, passed: false })).toEqual({
      kind: "execute_step",
      phaseId: "solo",
      stepId: "verify",
      outcome: "failure",
    });
  });
});

function soloDefinition(doneWhen: DoneWhenCriterion[]): RunDefinition {
  const phase: PhaseDocument = {
    id: "solo",
    deps: [],
    agentRole: "coder",
    description: "",
    tasks: ["do the work"],
    doneWhen,
    knowledge: [],
  };
  return {
    graph: buildPhaseGraph([phase]),
    steps: [{ id: "verify", maxAttempts: 1, onFail: { action: "escalate" } }],
    maxIterations: 100,
  };
}

// The COMPOSITION RULE made concrete: a caller runs gates ONLY when the step's own work succeeded; a
// failed step submits "failure" without touching runPhaseGates, so gates can never rescue a failure.
// The phase opens through a recall completion before its first step is dispensed.
async function submitFinalStep(
  run: WorkflowRun,
  definition: RunDefinition,
  doneWhen: DoneWhenCriterion[],
  options: GateRunOptions,
  agentOutcome: "success" | "failure",
): Promise<WorkflowRun> {
  run = applyStepResult(run, definition, { kind: "recall", phaseId: "solo" });
  const directive = reduce(run, definition);
  if (directive.kind !== "execute_step") {
    throw new Error(`expected an execute_step directive, received ${directive.kind}`);
  }
  if (agentOutcome === "failure") {
    return applyStepResult(run, definition, {
      kind: "execute_step",
      phaseId: directive.phaseId,
      stepId: directive.stepId,
      outcome: "failure",
    });
  }
  const report = await runPhaseGates(doneWhen, options);
  return applyStepResult(
    run,
    definition,
    stepResultFromGateReport(directive.phaseId, directive.stepId, report),
  );
}

describe("reducer integration through the gate seam", () => {
  test("a green gate leaves harvest pending; the harvest completion closes the phase", async () => {
    const doneWhen = [executable("command succeeds", "bun exit-zero.ts")];
    const definition = soloDefinition(doneWhen);
    let run = await submitFinalStep(
      initialRun(definition),
      definition,
      doneWhen,
      optionsFor(sharedProjectRoot),
      "success",
    );
    expect(run.status).toBe("running");
    expect(reduce(run, definition)).toEqual({ kind: "harvest", phaseId: "solo" });
    run = applyStepResult(run, definition, { kind: "harvest", phaseId: "solo" });
    expect(run.status).toBe("complete");
    expect(run.phaseStatuses["solo"]).toBe("closed");
  }, 15_000);

  test("a red gate does not close the phase", async () => {
    const doneWhen = [executable("command fails", "bun exit-one.ts")];
    const definition = soloDefinition(doneWhen);
    const run = await submitFinalStep(
      initialRun(definition),
      definition,
      doneWhen,
      optionsFor(sharedProjectRoot),
      "success",
    );
    expect(run.status).toBe("escalated");
    expect(run.phaseStatuses["solo"]).not.toBe("closed");
  }, 15_000);

  test("a failed step submits failure WITHOUT running gates", async () => {
    const projectRoot = makeProjectRoot();
    const doneWhen = [executable("marker is written", "bun write-marker.ts")];
    const definition = soloDefinition(doneWhen);
    const run = await submitFinalStep(
      initialRun(definition),
      definition,
      doneWhen,
      optionsFor(projectRoot),
      "failure",
    );
    expect(run.status).toBe("escalated");
    expect(run.phaseStatuses["solo"]).not.toBe("closed");
    expect(existsSync(join(projectRoot, "marker.txt"))).toBe(false);
  });
});
