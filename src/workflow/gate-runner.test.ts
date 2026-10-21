import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GATE_TIMEOUT_SECONDS,
  GateCommandFormatError,
  GateInputError,
  effectiveTimeoutSeconds,
  formatGateReport,
  runPhaseGates,
  stepResultFromGateReport,
  tokenizeCommand,
} from "./gate-runner";
import type { ExecutableCriterionResult, GateReport, GateRunOptions } from "./gate-runner";
import { MAX_GATE_TIMEOUT_SECONDS, MIN_GATE_TIMEOUT_SECONDS, parsePhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import { applyStepResult, initialRun, reduce } from "./reducer";
import type { RunDefinition, WorkflowRun } from "./reducer";
import type { DoneWhenCriterion, ExecutableCriterion, PhaseDocument } from "./phase-document";
import { stepAppliedPayload } from "./run-payloads";

// Output is written with writeSync on the raw descriptors: a buffered console.log could still be
// sitting in the process when SIGKILL arrives, and the test would then pin a flush race, not the gate.
const FIXTURE_SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ["exit-zero.ts", "process.exit(0);\n"],
  ["exit-one.ts", "process.exit(1);\n"],
  ["sleep.ts", "await Bun.sleep(60_000);\n"],
  ["write-marker.ts", 'import { writeFileSync } from "node:fs";\nwriteFileSync("marker.txt", "written");\n'],
  [
    "announce-then-sleep.ts",
    'import { writeSync } from "node:fs";\nwriteSync(1, "compiling the world\\n");\nawait Bun.sleep(60_000);\n',
  ],
  [
    "both-streams.ts",
    [
      'import { writeSync } from "node:fs";',
      'writeSync(1, "to stdout\\n");',
      'writeSync(2, "to stderr\\n");',
      "process.exit(1);",
      "",
    ].join("\n"),
  ],
  [
    "spawn-grandchild.ts",
    [
      'import { writeFileSync, writeSync } from "node:fs";',
      'const inherited = { stdin: "ignore", stdout: "inherit", stderr: "inherit" } as const;',
      'const grandchild = Bun.spawn(["sleep", "60"], inherited);',
      'writeFileSync("grandchild.pid", String(grandchild.pid));',
      "grandchild.unref();",
      'writeSync(1, "before sleep\\n");',
      "await Bun.sleep(60_000);",
      "",
    ].join("\n"),
  ],
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

function executable(description: string, command: string): ExecutableCriterion {
  return { kind: "executable", description, command, timeoutSeconds: null };
}

function limitedExecutable(description: string, command: string, timeoutSeconds: number): ExecutableCriterion {
  return { kind: "executable", description, command, timeoutSeconds };
}

function agentJudged(description: string): DoneWhenCriterion {
  return { kind: "agent-judged", description };
}

function optionsFor(projectRoot: string, agentVotes: GateRunOptions["agentVotes"] = []): GateRunOptions {
  return { projectRoot, agentVotes };
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
        durationMs: expect.any(Number),
        timeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
        outputTail: [],
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

  test("a command exceeding its criterion's own limit fails closed as timeout at that limit", async () => {
    const startedAt = performance.now();
    const report = await runPhaseGates(
      [limitedExecutable("hangs", "bun sleep.ts", 1)],
      optionsFor(sharedProjectRoot),
    );
    const elapsedMs = performance.now() - startedAt;
    expect(report.passed).toBe(false);
    expect(report.criterionResults[0]).toMatchObject({
      kind: "executable",
      passed: false,
      reason: "timeout",
      exitCode: null,
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});

describe("gate limits", () => {
  test("a criterion without a limit gets the five-minute default", () => {
    expect(DEFAULT_GATE_TIMEOUT_SECONDS).toBe(300);
    expect(effectiveTimeoutSeconds(executable("suite", "bun test"))).toBe(300);
  });

  test("the default lies inside the limits a fence may name", () => {
    expect(DEFAULT_GATE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(MIN_GATE_TIMEOUT_SECONDS);
    expect(DEFAULT_GATE_TIMEOUT_SECONDS).toBeLessThanOrEqual(MAX_GATE_TIMEOUT_SECONDS);
  });

  test("a criterion's own limit replaces the default", () => {
    expect(effectiveTimeoutSeconds(limitedExecutable("heavy suite", "bun test", 900))).toBe(900);
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
    expect(formatted).toMatch(/^PASS command succeeds \[exit-zero · \d+\.\d s\]$/m);
    expect(formatted).toContain("FAIL reviewer approves [agent-judged]");
    expect(formatted).toContain("agent-judged verdicts: 1 of 2 criteria");
  }, 15_000);

  test("the counter's total is executableCount plus agentJudgedCount, not the agent-judged count", () => {
    const report: GateReport = {
      passed: false,
      criterionResults: [
        executableOutcome({ description: "a", passed: true, reason: "exit-zero", exitCode: 0 }),
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

  const timedOut = executableOutcome({ description: "slow", passed: false, reason: "timeout", exitCode: null });
  const redExit = executableOutcome({ description: "red", passed: false, reason: "exit-nonzero", exitCode: 1 });
  const green = executableOutcome({ description: "green", passed: true, reason: "exit-zero", exitCode: 0 });

  function outcomeOf(criterionResults: GateReport["criterionResults"]): string {
    const report: GateReport = { passed: false, criterionResults, executableCount: 0, agentJudgedCount: 0 };
    return stepResultFromGateReport("solo", "verify", report).outcome;
  }

  test("a report whose every red criterion timed out is inconclusive, green neighbours aside", () => {
    expect(outcomeOf([timedOut])).toBe("inconclusive");
    expect(outcomeOf([green, timedOut, timedOut])).toBe("inconclusive");
  });

  test("a timeout beside any other red criterion is a failure", () => {
    expect(outcomeOf([timedOut, redExit])).toBe("failure");
    const rejectedReview: GateReport["criterionResults"][number] = {
      kind: "agent-judged",
      description: "review",
      passed: false,
      votes: [{ vote: "fail" }],
    };
    expect(outcomeOf([timedOut, rejectedReview])).toBe("failure");
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

type OutcomeFields = Pick<ExecutableCriterionResult, "description" | "passed" | "reason" | "exitCode">;

function executableOutcome(
  fields: OutcomeFields & Partial<ExecutableCriterionResult>,
): ExecutableCriterionResult {
  return {
    kind: "executable",
    command: "bun test",
    durationMs: 1000,
    timeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
    outputTail: [],
    ...fields,
  };
}

function reportOf(result: ExecutableCriterionResult): GateReport {
  return { passed: result.passed, criterionResults: [result], executableCount: 1, agentJudgedCount: 0 };
}

function verdictLines(result: ExecutableCriterionResult): string[] {
  return formatGateReport(reportOf(result)).split("\n").slice(0, -1);
}

describe("formatGateReport verdict lines", () => {
  test("a pass names its duration", () => {
    const result = executableOutcome({ description: "suite", passed: true, reason: "exit-zero", exitCode: 0 });

    expect(verdictLines({ ...result, durationMs: 38_200 })).toEqual(["PASS suite [exit-zero · 38.2 s]"]);
  });

  test("a red exit names its code and duration, with the output tail under it", () => {
    const result = executableOutcome({
      description: "suite",
      passed: false,
      reason: "exit-nonzero",
      exitCode: 1,
      durationMs: 41_000,
      outputTail: ["1 fail", "error: expected 2"],
    });

    expect(verdictLines(result)).toEqual([
      "FAIL suite [exit-nonzero 1 · 41.0 s]",
      "  output tail (last 2 lines):",
      "  | 1 fail",
      "  | error: expected 2",
    ]);
  });

  test("a timeout names how long it ran and the limit it hit, with the output tail under it", () => {
    const result = executableOutcome({
      description: "balance-check all",
      passed: false,
      reason: "timeout",
      exitCode: null,
      durationMs: 300_000,
      outputTail: ["Compiling spekulyant v0.3.0"],
    });

    expect(verdictLines(result)).toEqual([
      "FAIL balance-check all [timeout · 300.0 s, limit 300 s]",
      "  output tail (last 1 lines):",
      "  | Compiling spekulyant v0.3.0",
    ]);
  });

  test("a red run that printed nothing says so instead of showing an empty tail", () => {
    const result = executableOutcome({
      description: "suite",
      passed: false,
      reason: "exit-nonzero",
      exitCode: 2,
    });

    expect(verdictLines(result)).toEqual(["FAIL suite [exit-nonzero 2 · 1.0 s]", "  output tail: no output"]);
  });

  test("a command that never ran shows neither duration nor tail", () => {
    for (const reason of ["spawn-error", "malformed-command"] as const) {
      const result = executableOutcome({
        description: "suite",
        passed: false,
        reason,
        exitCode: null,
        durationMs: null,
      });

      expect(verdictLines(result)).toEqual([`FAIL suite [${reason}]`]);
    }
  });
});

describe("runPhaseGates measures and captures every run", () => {
  test("a run that exits names its duration and keeps an empty tail for a silent pass", async () => {
    const report = await runPhaseGates(
      [executable("passes", "bun exit-zero.ts"), executable("fails", "bun exit-one.ts")],
      optionsFor(sharedProjectRoot),
    );

    for (const result of report.criterionResults) {
      expect(result.kind === "executable" && typeof result.durationMs === "number").toBe(true);
    }
  }, 20_000);

  test("a command that never ran has no duration and no tail", async () => {
    const report = await runPhaseGates(
      [
        executable("missing binary", "definitely-not-a-real-binary-xyz run"),
        executable("quoted", 'bun "x.ts"'),
      ],
      optionsFor(sharedProjectRoot),
    );

    expect(report.criterionResults).toEqual([
      expect.objectContaining({ reason: "spawn-error", durationMs: null, outputTail: [] }),
      expect.objectContaining({ reason: "malformed-command", durationMs: null, outputTail: [] }),
    ]);
  }, 15_000);

  test("stdout and stderr both land in the tail, in the order they were written", async () => {
    const report = await runPhaseGates(
      [executable("noisy", "bun both-streams.ts")],
      optionsFor(sharedProjectRoot),
    );

    expect(report.criterionResults[0]).toMatchObject({
      reason: "exit-nonzero",
      outputTail: ["to stdout", "to stderr"],
    });
  }, 15_000);

  test("a timeout keeps what the command printed before it was killed", async () => {
    const report = await runPhaseGates(
      [limitedExecutable("slow build", "bun announce-then-sleep.ts", 1)],
      optionsFor(sharedProjectRoot),
    );

    expect(report.criterionResults[0]).toMatchObject({
      reason: "timeout",
      timeoutSeconds: 1,
      outputTail: ["compiling the world"],
    });
  }, 15_000);

  test("a grandchild still holding the output descriptor cannot hang the gate", async () => {
    const projectRoot = makeProjectRoot();
    const startedAt = performance.now();
    try {
      const report = await runPhaseGates(
        [limitedExecutable("forks and hangs", "bun spawn-grandchild.ts", 1)],
        optionsFor(projectRoot),
      );

      expect(performance.now() - startedAt).toBeLessThan(5000);
      expect(report.criterionResults[0]).toMatchObject({ reason: "timeout", outputTail: ["before sleep"] });
    } finally {
      process.kill(Number(readFileSync(join(projectRoot, "grandchild.pid"), "utf8")), "SIGKILL");
    }
  }, 15_000);

  test("the capture directory is gone once the gate has settled", async () => {
    const before = gateCaptureDirectories();

    await runPhaseGates([executable("noisy", "bun both-streams.ts")], optionsFor(sharedProjectRoot));

    expect(gateCaptureDirectories().filter((name) => !before.includes(name))).toEqual([]);
  }, 15_000);
});

describe("a limit parsed from a real phase document governs the gate", () => {
  test("timeout=1s on the fence kills the command at one second", async () => {
    const phaseText = [
      "---",
      'id: "smoke"',
      "deps: []",
      'agent-role: "coder"',
      "---",
      "## Tasks",
      "- run the slow suite",
      "",
      "## Done-when",
      "- hangs past its own limit",
      "```timeout=1s",
      "bun sleep.ts",
      "```",
      "",
    ].join("\n");
    const report = await runPhaseGates(parsePhaseDocument(phaseText).doneWhen, optionsFor(sharedProjectRoot));
    const [result] = report.criterionResults;

    expect(result).toMatchObject({ reason: "timeout", timeoutSeconds: 1 });
    expect(result?.kind === "executable" ? result.durationMs : null).toBeGreaterThanOrEqual(1000);
  }, 15_000);
});

describe("the gate payload carries numbers, never the output", () => {
  test("duration and limit are logged while the tail text is not", async () => {
    const report = await runPhaseGates(
      [executable("noisy", "bun both-streams.ts")],
      optionsFor(sharedProjectRoot),
    );
    const payload = stepAppliedPayload("01ARZ3NDEKTSV4RRFFQ69G5FA0", "main", {
      result: { kind: "execute_step", phaseId: "phase-one", stepId: "implement", outcome: "failure" },
      attempt: 1,
      gates: report,
      harvestedCount: null,
      dedupRejected: null,
      bundleNotes: null,
      usedNotes: null,
    });
    const [criterion] = (payload["gates"] as { criteria: Array<Record<string, unknown>> }).criteria;

    expect(criterion).toMatchObject({
      duration_ms: expect.any(Number),
      timeout_seconds: DEFAULT_GATE_TIMEOUT_SECONDS,
    });
    expect(JSON.stringify(payload)).not.toContain("to stdout");
    expect(JSON.stringify(payload)).not.toContain("to stderr");
  }, 15_000);
});

function gateCaptureDirectories(): string[] {
  return readdirSync(tmpdir()).filter(
    (name) => name.startsWith("mneme-gate-") && !name.startsWith("mneme-gate-fixture-"),
  );
}
