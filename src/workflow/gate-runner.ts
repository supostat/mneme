import { evaluateConverge } from "./converge";
import type { AgentVote } from "./converge";
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

// Gate commands are full test/build runs; the ceiling is generous and overridable for fast tests.
export const GATE_COMMAND_TIMEOUT_MS = 300_000;

const QUOTE_CHARACTERS: readonly string[] = ['"', "'"];
const SPACE_RUN = / +/;

export type ExecutableGateReason =
  | "exit-zero"
  | "exit-nonzero"
  | "timeout"
  | "spawn-error"
  | "malformed-command";

export interface ExecutableCriterionResult {
  kind: "executable";
  description: string;
  command: string;
  passed: boolean;
  reason: ExecutableGateReason;
  exitCode: number | null;
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
  commandTimeoutMs?: number;
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
  const timeoutMs = options.commandTimeoutMs ?? GATE_COMMAND_TIMEOUT_MS;
  const criterionResults: CriterionResult[] = [];
  let agentJudgedIndex = 0;
  for (const criterion of doneWhen) {
    if (criterion.kind === "agent-judged") {
      const votes = voteArrayAt(options.agentVotes, agentJudgedIndex);
      agentJudgedIndex += 1;
      criterionResults.push(evaluateAgentJudged(criterion.description, votes));
    } else {
      criterionResults.push(await runExecutableCriterion(criterion, options.projectRoot, timeoutMs));
    }
  }
  return buildGateReport(criterionResults);
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
  const lines = report.criterionResults.map(formatCriterionResult);
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
    passed: evaluateConverge(votes.map((agentVote) => agentVote.vote), votes.length),
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
  timeoutMs: number,
): Promise<ExecutableCriterionResult> {
  let command: string[];
  try {
    command = tokenizeCommand(criterion.command);
  } catch {
    // fail closed: an un-runnable command reads as a red malformed-command gate, never a thrown run.
    return executableResult(criterion, "malformed-command", null);
  }
  const execution = await executeCommand(command, projectRoot, timeoutMs);
  if (execution === "spawn-error") {
    return executableResult(criterion, "spawn-error", null);
  }
  if (execution.timedOut) {
    return executableResult(criterion, "timeout", null);
  }
  if (execution.exitCode === 0) {
    return executableResult(criterion, "exit-zero", 0);
  }
  return executableResult(criterion, "exit-nonzero", execution.exitCode);
}

interface CommandExecution {
  timedOut: boolean;
  exitCode: number;
}

async function executeCommand(
  command: string[],
  projectRoot: string,
  timeoutMs: number,
): Promise<CommandExecution | "spawn-error"> {
  const subprocess = trySpawn(command, projectRoot);
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
  // stderr is discarded at the spawn (stderr: "ignore"), never drained here: awaiting a stderr read to
  // EOF after SIGKILL can hang forever if a killed command left a grandchild holding the write end, which
  // would defeat the timeout invariant. A red gate is diagnosed by reason + exitCode, not captured stderr.
  const exitCode = await subprocess.exited;
  clearTimeout(timer);
  return { timedOut, exitCode };
}

function trySpawn(command: string[], projectRoot: string) {
  try {
    return Bun.spawn({
      cmd: command,
      cwd: projectRoot,
      stdout: "ignore",
      stderr: "ignore",
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
): ExecutableCriterionResult {
  return {
    kind: "executable",
    description: criterion.description,
    command: criterion.command,
    passed: reason === "exit-zero",
    reason,
    exitCode,
  };
}

function formatCriterionResult(result: CriterionResult): string {
  const marker = result.passed ? "PASS" : "FAIL";
  if (result.kind === "executable") {
    return `${marker} ${result.description} [${result.reason}]`;
  }
  return `${marker} ${result.description} [agent-judged]`;
}
