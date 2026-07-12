import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";
import type { Directive, ExecuteStepDirective } from "./reducer";
import { isFinalStep, pendingDirectiveOf, phaseOf } from "./run-events";
import type { ReadableRun, UnreadableRun } from "./run-events";
import type { RunSurvey, StaleMark } from "./run-survey";

// Renders the workflow tool responses. Every string here is plain ASCII by contract: the envelopes
// travel through stdio MCP responses where exotic separators (U+2028/U+2029/U+0085) are forbidden.
// Unreadable-run fields are the one exception — they come from arbitrary log bytes that failed
// validation — so they are stripped of control and separator characters before rendering.

type CodePointRange = readonly [number, number];

const C0_CONTROLS: CodePointRange = [0x0000, 0x001f];
const DELETE_AND_C1_CONTROLS: CodePointRange = [0x007f, 0x009f];
const LINE_AND_PARAGRAPH_SEPARATORS: CodePointRange = [0x2028, 0x2029];

const UNRENDERABLE_CHARACTER_REGEX = unrenderableCharacterRegex([
  C0_CONTROLS,
  DELETE_AND_C1_CONTROLS,
  LINE_AND_PARAGRAPH_SEPARATORS,
]);

function unrenderableCharacterRegex(ranges: readonly CodePointRange[]): RegExp {
  const characterClass = ranges
    .map(([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`)
    .join("");
  return new RegExp(`[${characterClass}]`, "gu");
}

function stripUnrenderableCharacters(value: string): string {
  return value.replace(UNRENDERABLE_CHARACTER_REGEX, "");
}

export function joinSections(sections: string[]): string {
  return sections.filter((section) => section !== "").join("\n\n");
}

export function renderRunStarted(runId: string, branch: string): string {
  return [
    `Started workflow run ${runId} on branch "${branch}".`,
    "Run state lives only in the append-only event log. Call workflow_step {} to receive the first directive.",
  ].join("\n");
}

export function renderRunHeader(active: ReadableRun): string {
  return (
    `Workflow run ${active.runId} [branch "${active.branch}"] ` +
    `status=${active.run.status} iterations=${active.run.iterationsUsed}/${active.definition.maxIterations}`
  );
}

export function renderExistingRunNotice(runId: string): string {
  return [
    `NOTICE: an unfinished workflow run already exists on this branch: ${runId}.`,
    "The submitted definition was IGNORED. Call workflow_step to resume the existing run.",
  ].join("\n");
}

export function renderReissueNotice(pendingDescription: string): string {
  return [
    `NOTICE: the submission does not match the pending directive (${pendingDescription}).`,
    "Nothing was applied and no state changed. The current directive follows; echo it exactly.",
  ].join("\n");
}

export function renderCurrentDirective(active: ReadableRun): string {
  const directive = pendingDirectiveOf(active);
  if (directive.kind === "execute_step") {
    return renderExecuteStepDirective(active, directive);
  }
  if (directive.kind === "harvest") {
    return renderHarvestDirective(active.runId, directive.phaseId);
  }
  return renderTerminal(directive);
}

function renderExecuteStepDirective(active: ReadableRun, directive: ExecuteStepDirective): string {
  const lines = [
    "DIRECTIVE: execute_step",
    `phase: ${directive.phaseId}`,
    `step: ${directive.stepId}`,
    `attempt: ${directive.attempt}`,
    `agent-role: ${directive.agentRole}`,
  ];
  if (isFinalStep(active.definition, active.run)) {
    lines.push(...finalStepSection(phaseOf(active.definition, directive.phaseId)));
  }
  lines.push(
    "Submit by ECHOING the directive:",
    `workflow_step { run_id: "${active.runId}", step_result: { phase_id: "${directive.phaseId}", ` +
      `step_id: "${directive.stepId}", attempt: ${directive.attempt}, outcome: "success" | "failure" } }`,
  );
  return lines.join("\n");
}

function renderHarvestDirective(runId: string, phaseId: string): string {
  return [
    "DIRECTIVE: harvest",
    `phase: ${phaseId}`,
    "The phase's steps are done. Submit harvest_artifacts (an empty array is allowed) to close it:",
    `workflow_step { run_id: "${runId}", harvest_artifacts: ` +
      '[ { kind: "fixed_test" | "resolved_error" | "decision", ...template fields..., anchors: ["path"] } ] }',
  ].join("\n");
}

function renderTerminal(directive: Directive): string {
  if (directive.kind === "run_complete") {
    return "RUN COMPLETE: every phase is closed. Start a new run with workflow_start when needed.";
  }
  if (directive.kind === "run_failed") {
    return `RUN FAILED: ${directive.reason}. Terminal runs are never resumed; start a new run with workflow_start.`;
  }
  if (directive.kind === "escalate") {
    return (
      `RUN ESCALATED at ${directive.phaseId}/${directive.stepId}: ${directive.reason}. ` +
      "Terminal runs are never resumed; start a new run with workflow_start."
    );
  }
  throw new Error(`directive "${directive.kind}" is not terminal`);
}

function renderStaleSection(marked: StaleMark[]): string {
  const lines = ["STALE RUNS (branch not found):"];
  for (const mark of marked) {
    lines.push(
      `- run ${mark.runId} was anchored to branch "${mark.branch}", which no longer exists; ` +
        "it is now marked stale and can NEVER be resumed, even if the branch name is recreated.",
    );
  }
  lines.push("Ask the user how to proceed; start a new run with workflow_start if the work still matters.");
  return lines.join("\n");
}

function renderPausedRuns(paused: ReadableRun[]): string {
  const lines = ["Paused runs on other branches:"];
  for (const run of paused) {
    lines.push(`- run ${run.runId} [branch "${run.branch}"] - check out that branch and call workflow_step to resume it.`);
  }
  return lines.join("\n");
}

function renderBranchWarnings(indeterminateRuns: ReadableRun[]): string {
  return indeterminateRuns
    .map(
      (run) =>
        `WARNING: could not verify that branch "${run.branch}" (run ${run.runId}) still exists; the run was NOT marked stale.`,
    )
    .join("\n");
}

function renderAnomalies(unreadableRuns: UnreadableRun[], supersededRunning: ReadableRun[]): string {
  const lines = ["LOG ANOMALIES:"];
  for (const run of unreadableRuns) {
    lines.push(renderUnreadableRun(run));
  }
  for (const run of supersededRunning) {
    lines.push(
      `- multiple running runs on branch "${run.branch}": run ${run.runId} is superseded by the newest started run and will not be resumed.`,
    );
  }
  return lines.join("\n");
}

// runId, branch and problem of an unreadable run all derive from unvalidated log bytes (the problem
// may embed a hostile branch name), so every field is stripped, not only the id.
function renderUnreadableRun(run: UnreadableRun): string {
  const runId = stripUnrenderableCharacters(run.runId);
  const branchLabel = run.branch === null ? "" : ` [branch "${stripUnrenderableCharacters(run.branch)}"]`;
  return `- run ${runId}${branchLabel} is unreadable and will not be resumed: ${stripUnrenderableCharacters(run.problem)}`;
}

export function surveySections(survey: RunSurvey): string[] {
  const sections: string[] = [];
  if (survey.markedStale.length > 0) {
    sections.push(renderStaleSection(survey.markedStale));
  }
  if (survey.pausedRuns.length > 0) {
    sections.push(renderPausedRuns(survey.pausedRuns));
  }
  if (survey.indeterminateRuns.length > 0) {
    sections.push(renderBranchWarnings(survey.indeterminateRuns));
  }
  if (survey.unreadableRuns.length > 0 || survey.supersededRunning.length > 0) {
    sections.push(renderAnomalies(survey.unreadableRuns, survey.supersededRunning));
  }
  return sections;
}

export function renderNoActiveRun(survey: RunSurvey): string {
  const sections = [`No unfinished workflow run on branch "${survey.branch}".`];
  if (survey.lastTerminalRun !== null) {
    sections.push(
      `Last terminal run on this branch: ${survey.lastTerminalRun.runId} [${survey.lastTerminalRun.run.status}]. ` +
        "Terminal runs are never resumed; call workflow_start for a new run.",
    );
  }
  for (const staleRun of survey.staleRunsOfBranch) {
    sections.push(`Run ${staleRun.runId} on this branch was marked stale (branch_not_found) and can never be resumed.`);
  }
  return joinSections([...sections, ...surveySections(survey)]);
}

export function describePending(directive: Directive): string {
  if (directive.kind === "execute_step") {
    return `pending: execute_step ${directive.phaseId}/${directive.stepId} attempt ${directive.attempt}`;
  }
  if (directive.kind === "harvest") {
    return `pending: harvest for phase ${directive.phaseId}`;
  }
  if (directive.kind === "recall") {
    return `pending: recall for phase ${directive.phaseId}`;
  }
  return `the run is terminal: ${directive.kind}`;
}

function finalStepSection(phase: PhaseDocument): string[] {
  const agentJudgedCount = phase.doneWhen.filter((criterion) => criterion.kind === "agent-judged").length;
  const lines = [
    "This is the phase's FINAL step: a success submission runs the done-when gates (a failure never does).",
    "done-when criteria:",
    ...phase.doneWhen.map(describeCriterion),
  ];
  lines.push(
    agentJudgedCount === 0
      ? "Do not send agent_votes: every criterion is executable."
      : `With outcome "success", send agent_votes: exactly ${agentJudgedCount} non-empty array(s) of "pass"|"fail" votes, one per agent-judged criterion in order.`,
  );
  return lines;
}

function describeCriterion(criterion: DoneWhenCriterion): string {
  if (criterion.kind === "executable") {
    return `- [executable] ${criterion.description} (command: ${criterion.command})`;
  }
  return `- [agent-judged] ${criterion.description}`;
}
