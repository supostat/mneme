import { closeSync } from "node:fs";
import { evaluateConverge } from "./converge";
import type { AgentVote } from "./converge";
import { createOutputCapture, readOutputTail, removeOutputCapture } from "./gate-output";
import type { OutputCapture } from "./gate-output";
import type { DoneWhenCriterion, ExecutableCriterion } from "./phase-document";
import type { ExecuteStepResult } from "./reducer";

// Gate evaluation runs BESIDE the reducer, never inside it: the caller reduces the final step, runs
// runPhaseGates over the phase's done-when criteria, then maps the report with stepResultFromGateReport
// before applyStepResult. runPhaseGates is a pure evaluator over criteria and knows nothing about the
// step's own agent outcome. COMPOSITION RULE, owned by the caller: gates run only when the step's own
// work succeeded; a failed step submits outcome "failure" WITHOUT running gates, so gate evaluation can
// never turn an agent failure into a success.

// Thrown at entry on a caller-contract violation (empty criteria, vote-count mismatch); never caught here.
export class GateInputError extends Error {}

// Thrown by tokenizeCommand on an un-runnable command; caught internally and mapped to a fail-closed
// malformed-command result so a bad command reads as a red gate rather than crashing the run.
export class GateCommandFormatError extends Error {}

// Gate commands are full test/build runs; a criterion whose fence names no limit gets this ceiling.
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300;

const MILLISECONDS_PER_SECOND = 1000;
const OUTPUT_TAIL_INDENT = "  ";
// Every captured line is prefixed, so no line of a command's output can pass for a line of the
// engine's own response (a forged "DIRECTIVE:" or verdict line).
const OUTPUT_LINE_PREFIX = "| ";

const QUOTE_CHARACTERS: readonly string[] = ['"', "'"];
const SPACE_RUN = / +/;

export type ExecutableGateReason =
  | "exit-zero"
  | "exit-nonzero"
  | "timeout"
  | "spawn-error"
  | "malformed-command";

// durationMs is null when the command never ran (malformed-command, spawn-error); timeoutSeconds is
// the limit the gate actually applied; outputTail is the end of the combined stdout+stderr and lives
// only in the verdict text — it is never written to the event log.
export interface ExecutableCriterionResult {
  kind: "executable";
  description: string;
  command: string;
  passed: boolean;
  reason: ExecutableGateReason;
  exitCode: number | null;
  durationMs: number | null;
  timeoutSeconds: number;
  outputTail: string[];
}

export interface AgentJudgedCriterionResult {
  kind: "agent-judged";
  description: string;
  passed: boolean;
  votes: AgentVote[];
}

export type CriterionResult = ExecutableCriterionResult | AgentJudgedCriterionResult;

export interface GateReport {
  passed: boolean;
  criterionResults: CriterionResult[];
  executableCount: number;
  agentJudgedCount: number;
}

export interface GateRunOptions {
  projectRoot: string;
  agentVotes: AgentVote[][];
}

export async function runPhaseGates(
  doneWhen: DoneWhenCriterion[],
  options: GateRunOptions,
): Promise<GateReport> {
  if (doneWhen.length === 0) {
    throw new GateInputError("cannot evaluate gates for an empty done-when list");
  }
  const agentJudgedCriterionCount = doneWhen.filter(
    (criterion) => criterion.kind === "agent-judged",
  ).length;
  if (options.agentVotes.length !== agentJudgedCriterionCount) {
    throw new GateInputError(
      `expected ${agentJudgedCriterionCount} agent vote arrays, received ${options.agentVotes.length}`,
    );
  }
  const criterionResults: CriterionResult[] = [];
  let agentJudgedIndex = 0;
  for (const criterion of doneWhen) {
    if (criterion.kind === "agent-judged") {
      const votes = voteArrayAt(options.agentVotes, agentJudgedIndex);
      agentJudgedIndex += 1;
      criterionResults.push(evaluateAgentJudged(criterion.description, votes));
    } else {
      criterionResults.push(await runExecutableCriterion(criterion, options.projectRoot));
    }
  }
  return buildGateReport(criterionResults);
}

export function effectiveTimeoutSeconds(criterion: ExecutableCriterion): number {
  return criterion.timeoutSeconds ?? DEFAULT_GATE_TIMEOUT_SECONDS;
}

// Maps a report to a step outcome. Per the COMPOSITION RULE above, the caller invokes this only after
// the step's own work succeeded, so a red gate becomes a step failure the reducer retries or escalates.
export function stepResultFromGateReport(
  phaseId: string,
  stepId: string,
  report: GateReport,
): ExecuteStepResult {
  return { kind: "execute_step", phaseId, stepId, outcome: report.passed ? "success" : "failure" };
}

export function formatGateReport(report: GateReport): string {
  const lines = report.criterionResults.flatMap(formatCriterionResult);
  lines.push(
    `agent-judged verdicts: ${report.agentJudgedCount} of ${report.criterionResults.length} criteria`,
  );
  return lines.join("\n");
}

export function tokenizeCommand(command: string): string[] {
  for (const quote of QUOTE_CHARACTERS) {
    if (command.includes(quote)) {
      throw new GateCommandFormatError(
        `done-when command must not contain quote characters: ${command}`,
      );
    }
  }
  // The schema validates commands as single lines free of tabs and control characters, so splitting on
  // runs of U+0020 alone is total here: no other whitespace can reach this function.
  const tokens = command.trim().split(SPACE_RUN);
  const program = tokens[0];
  if (program === undefined || program === "") {
    throw new GateCommandFormatError("done-when command must not be empty");
  }
  if (program.startsWith("-")) {
    throw new GateCommandFormatError(
      `done-when command must start with a program, not a flag: ${command}`,
    );
  }
  return tokens;
}

function buildGateReport(criterionResults: CriterionResult[]): GateReport {
  const executableCount = criterionResults.filter((result) => result.kind === "executable").length;
  return {
    passed: criterionResults.every((result) => result.passed),
    criterionResults,
    executableCount,
    agentJudgedCount: criterionResults.length - executableCount,
  };
}

function evaluateAgentJudged(description: string, votes: AgentVote[]): AgentJudgedCriterionResult {
  return {
    kind: "agent-judged",
    description,
    passed: evaluateConverge(votes.map((agentVote) => agentVote.vote)),
    votes,
  };
}

function voteArrayAt(agentVotes: AgentVote[][], index: number): AgentVote[] {
  const votes = agentVotes[index];
  if (votes === undefined) {
    throw new Error(`missing agent vote array at index ${index}: gate vote-count invariant violated`);
  }
  return votes;
}

async function runExecutableCriterion(
  criterion: ExecutableCriterion,
  projectRoot: string,
): Promise<ExecutableCriterionResult> {
  let command: string[];
  try {
    command = tokenizeCommand(criterion.command);
  } catch {
    // fail closed: an un-runnable command reads as a red malformed-command gate, never a thrown run.
    return executableResult(criterion, "malformed-command", null, null);
  }
  const timeoutMs = effectiveTimeoutSeconds(criterion) * MILLISECONDS_PER_SECOND;
  const execution = await executeCommand(command, projectRoot, timeoutMs);
  if (execution === "spawn-error") {
    return executableResult(criterion, "spawn-error", null, null);
  }
  if (execution.timedOut) {
    return executableResult(criterion, "timeout", null, execution);
  }
  if (execution.exitCode === 0) {
    return executableResult(criterion, "exit-zero", 0, execution);
  }
  return executableResult(criterion, "exit-nonzero", execution.exitCode, execution);
}

interface CommandExecution {
  timedOut: boolean;
  exitCode: number;
  durationMs: number;
  outputTail: string[];
}

type MeasuredRun = Pick<CommandExecution, "durationMs" | "outputTail">;

async function executeCommand(
  command: string[],
  projectRoot: string,
  timeoutMs: number,
): Promise<CommandExecution | "spawn-error"> {
  const capture = tryCreateOutputCapture();
  if (capture === null) {
    return "spawn-error";
  }
  try {
    return await runCaptured(command, projectRoot, timeoutMs, capture);
  } finally {
    removeOutputCapture(capture);
  }
}

async function runCaptured(
  command: string[],
  projectRoot: string,
  timeoutMs: number,
  capture: OutputCapture,
): Promise<CommandExecution | "spawn-error"> {
  const startedAt = performance.now();
  const subprocess = trySpawn(command, projectRoot, capture.descriptor);
  // The child holds its own copy of the descriptor now; the engine's copy is closed at once, on the
  // spawn-error path too, so the engine itself never keeps the capture file open.
  closeSync(capture.descriptor);
  if (subprocess === null) {
    return "spawn-error";
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL does not reap grandchildren: Bun exposes no process-group kill, so a gate command that
    // forks can leak descendants. Accepted for repo-authored commands; named for Phase 11 hardening.
    subprocess.kill("SIGKILL");
  }, timeoutMs);
  // Timer race (fail-closed): a command exiting 0 exactly as the timer fires is read as a timeout, a
  // green->red misclassification. Accepted; the reducer re-runs the step on the red gate.
  // The sole await is exited — SIGKILL is uncatchable, so it always settles. The output is read from
  // the capture file only afterwards, and a file read never waits on a writer, so a grandchild still
  // holding the descriptor cannot defeat the timeout (see gate-output.ts).
  const exitCode = await subprocess.exited;
  clearTimeout(timer);
  return {
    timedOut,
    exitCode,
    durationMs: Math.round(performance.now() - startedAt),
    outputTail: readOutputTail(capture.path),
  };
}

// fail closed: a capture that cannot be created (the temp directory full or unwritable) means the
// command never ran, so it reads as a red spawn-error gate rather than a crashed run.
function tryCreateOutputCapture(): OutputCapture | null {
  try {
    return createOutputCapture();
  } catch {
    return null;
  }
}

function trySpawn(command: string[], projectRoot: string, outputDescriptor: number) {
  try {
    return Bun.spawn({
      cmd: command,
      cwd: projectRoot,
      stdout: outputDescriptor,
      stderr: outputDescriptor,
      stdin: "ignore",
    });
  } catch {
    // fail closed: a synchronous spawn throw (e.g. ENOENT) maps to a red spawn-error gate, never a crash.
    return null;
  }
}

function executableResult(
  criterion: ExecutableCriterion,
  reason: ExecutableGateReason,
  exitCode: number | null,
  measured: MeasuredRun | null,
): ExecutableCriterionResult {
  return {
    kind: "executable",
    description: criterion.description,
    command: criterion.command,
    passed: reason === "exit-zero",
    reason,
    exitCode,
    durationMs: measured === null ? null : measured.durationMs,
    timeoutSeconds: effectiveTimeoutSeconds(criterion),
    outputTail: measured === null ? [] : measured.outputTail,
  };
}

function formatCriterionResult(result: CriterionResult): string[] {
  const marker = result.passed ? "PASS" : "FAIL";
  if (result.kind === "agent-judged") {
    return [`${marker} ${result.description} [agent-judged]`];
  }
  const verdictLine = `${marker} ${result.description} [${executableOutcomeLabel(result)}]`;
  return showsOutputTail(result) ? [verdictLine, ...outputTailLines(result.outputTail)] : [verdictLine];
}

function executableOutcomeLabel(result: ExecutableCriterionResult): string {
  if (result.durationMs === null) {
    return result.reason;
  }
  const elapsed = `${(result.durationMs / MILLISECONDS_PER_SECOND).toFixed(1)} s`;
  if (result.reason === "timeout") {
    return `timeout · ${elapsed}, limit ${result.timeoutSeconds} s`;
  }
  if (result.reason === "exit-nonzero") {
    return `exit-nonzero ${result.exitCode} · ${elapsed}`;
  }
  return `${result.reason} · ${elapsed}`;
}

// The tail is shown under a red criterion whose command actually ran: it is the evidence the agent
// would otherwise have to reconstruct by re-running the gate or reading the event log.
function showsOutputTail(result: ExecutableCriterionResult): boolean {
  return result.reason === "timeout" || result.reason === "exit-nonzero";
}

function outputTailLines(outputTail: string[]): string[] {
  if (outputTail.length === 0) {
    return [`${OUTPUT_TAIL_INDENT}output tail: no output`];
  }
  return [
    `${OUTPUT_TAIL_INDENT}output tail (last ${outputTail.length} lines):`,
    ...outputTail.map((line) => `${OUTPUT_TAIL_INDENT}${OUTPUT_LINE_PREFIX}${line}`),
  ];
}
