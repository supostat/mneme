import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WORKFLOW_ON_FAIL_ACTIONS, WORKFLOW_STEP_OUTCOMES } from "../event-schema";
import { textResult } from "../mcp-rendering";
import { validateAnchor } from "../note";
import type { StagingDeps } from "../staging";
import type { Vote } from "./converge";
import type { StepDefinition } from "./failure-policy";
import type { PhaseArtifact } from "./memory-steps";
import { parsePhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import { applyStepResult, initialRun } from "./reducer";
import type { RunDefinition, StepResult } from "./reducer";
import { resolveCurrentBranch } from "./run-branch";
import {
  describePending,
  joinSections,
  renderCurrentDirective,
  renderExistingRunNotice,
  renderNoActiveRun,
  renderReissueNotice,
  renderRunHeader,
  renderRunStarted,
  surveySections,
} from "./run-directives";
import { isFinalStep, pendingDirectiveOf } from "./run-events";
import type { ReadableRun, RunRetrievalConfig } from "./run-events";
import { appendStepApplied, applyGatedFinalStep, applyHarvest, echoMatches, runEngineSteps } from "./run-executor";
import { runStartedPayload } from "./run-payloads";
import { surveyRuns } from "./run-survey";

export class WorkflowToolError extends Error {}

export const DEFAULT_WORKFLOW_RECALL_BUDGET = 2000;
const VOTE_VALUES = ["pass", "fail"] as const;

export const WORKFLOW_START_DESCRIPTION =
  "Start a workflow run anchored to the CURRENT git branch. phases are phase-document markdown " +
  "texts; steps define the retry/failure policy applied inside every phase; run state lives only " +
  "in the append-only event log. If this branch already has an unfinished run, its run_id is " +
  "returned and the submitted definition is IGNORED. Call workflow_step for the first directive.";
export const WORKFLOW_STEP_DESCRIPTION =
  "Advance or inspect the current branch's workflow run. The reducer decides ALL sequencing; the " +
  "caller never chooses the next step - it only executes the pending directive and submits the " +
  "result, looping until the run is terminal. " +
  "Calling with no arguments is ALWAYS a safe sync that re-issues the pending directive. A " +
  "step_result submission must ECHO the pending directive's phase_id, step_id and attempt; a " +
  "mismatched echo changes nothing and re-issues the directive. Done-when gates run only when the " +
  "phase's FINAL step succeeds - send agent_votes (one pass|fail array per agent-judged criterion) " +
  "with that submission; a failure never runs gates. When a harvest directive is pending, submit " +
  "harvest_artifacts (an empty array is allowed) to close the phase.";

export const WORKFLOW_START_INPUT = {
  phases: z.array(z.string()).min(1),
  steps: z
    .array(
      z.object({
        id: z.string(),
        max_attempts: z.number().int().positive(),
        on_fail: z.object({ action: z.enum(WORKFLOW_ON_FAIL_ACTIONS), to: z.string().optional() }),
      }),
    )
    .min(1),
  max_iterations: z.number().int().positive(),
  recall_budget: z.number().int().positive().optional(),
  recall_anchors: z.record(z.string(), z.array(z.string())).optional(),
};

const harvestArtifact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed_test"), test: z.string(), failure: z.string(), fix: z.string(), anchors: z.array(z.string()) }),
  z.object({ kind: z.literal("resolved_error"), error: z.string(), resolution: z.string(), anchors: z.array(z.string()) }),
  z.object({ kind: z.literal("decision"), decision: z.string(), rationale: z.string(), anchors: z.array(z.string()) }),
]);

export const WORKFLOW_STEP_INPUT = {
  run_id: z.string().optional(),
  step_result: z
    .object({
      phase_id: z.string(),
      step_id: z.string(),
      attempt: z.number().int().positive(),
      outcome: z.enum(WORKFLOW_STEP_OUTCOMES),
    })
    .optional(),
  agent_votes: z.array(z.array(z.enum(VOTE_VALUES)).min(1)).optional(),
  harvest_artifacts: z.array(harvestArtifact).optional(),
};

export interface WorkflowStartArgs {
  phases: string[];
  steps: Array<{
    id: string;
    max_attempts: number;
    on_fail: { action: (typeof WORKFLOW_ON_FAIL_ACTIONS)[number]; to?: string };
  }>;
  max_iterations: number;
  recall_budget?: number;
  recall_anchors?: Record<string, string[]>;
}

export interface SubmittedStepResult {
  phase_id: string;
  step_id: string;
  attempt: number;
  outcome: (typeof WORKFLOW_STEP_OUTCOMES)[number];
}

export interface WorkflowStepArgs {
  run_id?: string;
  step_result?: SubmittedStepResult;
  agent_votes?: Vote[][];
  harvest_artifacts?: PhaseArtifact[];
}

export async function workflowStartTool(deps: StagingDeps, args: WorkflowStartArgs): Promise<CallToolResult> {
  const resolution = await resolveCurrentBranch(deps.projectRoot);
  if (resolution.kind === "git-error") {
    throw new WorkflowToolError("cannot start a workflow run: git failed to resolve the current branch");
  }
  if (resolution.kind === "detached") {
    throw new WorkflowToolError("cannot start a workflow run on a detached HEAD: runs anchor to a branch");
  }
  const survey = await surveyRuns(deps, resolution.name);
  if (survey.activeRun !== null) {
    return textResult(joinSections([renderExistingRunNotice(survey.activeRun.runId), ...surveySections(survey)]));
  }
  const definition = buildDefinitionFromArgs(args);
  const retrieval: RunRetrievalConfig = {
    recallBudget: args.recall_budget ?? DEFAULT_WORKFLOW_RECALL_BUDGET,
    recallAnchors: args.recall_anchors ?? {},
  };
  requireValidRecallAnchors(definition, retrieval.recallAnchors);
  initialRun(definition); // re-validates the step policy before anything is persisted
  const runId = deps.idFactory();
  deps.eventWriter.append({
    ...runStartedPayload(runId, resolution.name, definition, retrieval),
    type: "workflow_run_started",
  });
  return textResult(joinSections([renderRunStarted(runId, resolution.name), ...surveySections(survey)]));
}

export async function workflowStepTool(deps: StagingDeps, args: WorkflowStepArgs): Promise<CallToolResult> {
  validateStepArguments(args);
  const submitting = args.step_result !== undefined || args.harvest_artifacts !== undefined;
  const resolution = await resolveCurrentBranch(deps.projectRoot);
  if (resolution.kind !== "branch") {
    return respondOffBranch(resolution.kind, submitting);
  }
  const survey = await surveyRuns(deps, resolution.name);
  if (survey.activeRun === null) {
    if (submitting) {
      throw new WorkflowToolError(`no unfinished workflow run on branch "${resolution.name}" accepts a submission`);
    }
    return textResult(renderNoActiveRun(survey));
  }
  const active = survey.activeRun;
  requireMatchingRunId(args, active, submitting);
  const sections: string[] = [];
  sections.push(...(await runEngineSteps(deps, active)));
  if (args.step_result !== undefined) {
    sections.push(...(await applyIncomingStepResult(deps, active, args.step_result, args.agent_votes)));
  } else if (args.harvest_artifacts !== undefined) {
    sections.push(...(await applyIncomingHarvest(deps, active, args.harvest_artifacts)));
  }
  sections.push(...(await runEngineSteps(deps, active)));
  return textResult(
    joinSections([renderRunHeader(active), ...sections, renderCurrentDirective(active), ...surveySections(survey)]),
  );
}

// Echo idempotency: a submission that does not exactly restate the pending execute_step directive
// (phase, step, attempt) changes nothing and re-issues the directive; only a matching final-step
// success reaches the gates.
async function applyIncomingStepResult(
  deps: StagingDeps,
  active: ReadableRun,
  submitted: SubmittedStepResult,
  agentVotes: Vote[][] | undefined,
): Promise<string[]> {
  const pending = pendingDirectiveOf(active);
  if (pending.kind !== "execute_step" || !echoMatches(pending, submitted)) {
    return [renderReissueNotice(describePending(pending))];
  }
  if (submitted.outcome === "success" && isFinalStep(active.definition, active.run)) {
    return applyGatedFinalStep(deps, active, pending, agentVotes ?? []);
  }
  if (agentVotes !== undefined) {
    throw new WorkflowToolError("agent_votes are only accepted with a success submission of the phase's final step");
  }
  const result: StepResult = {
    kind: "execute_step",
    phaseId: pending.phaseId,
    stepId: pending.stepId,
    outcome: submitted.outcome,
  };
  active.run = applyStepResult(active.run, active.definition, result);
  appendStepApplied(deps, active, { result, attempt: pending.attempt, gates: null, harvestedCount: null });
  return [`Applied ${submitted.outcome} for ${pending.phaseId}/${pending.stepId} (attempt ${pending.attempt}); gates were not run.`];
}

// Harvest idempotency mirrors the step-result echo gate: a harvest submission arriving while no
// harvest directive is pending changes nothing and re-issues the current directive.
async function applyIncomingHarvest(
  deps: StagingDeps,
  active: ReadableRun,
  artifacts: PhaseArtifact[],
): Promise<string[]> {
  const pending = pendingDirectiveOf(active);
  if (pending.kind !== "harvest") {
    return [renderReissueNotice(describePending(pending))];
  }
  return applyHarvest(deps, active, pending, artifacts);
}

function validateStepArguments(args: WorkflowStepArgs): void {
  if (args.step_result !== undefined && args.harvest_artifacts !== undefined) {
    throw new WorkflowToolError("step_result and harvest_artifacts are mutually exclusive");
  }
  if (args.agent_votes !== undefined && args.step_result === undefined) {
    throw new WorkflowToolError("agent_votes are only valid alongside step_result");
  }
  const submitting = args.step_result !== undefined || args.harvest_artifacts !== undefined;
  if (submitting && args.run_id === undefined) {
    throw new WorkflowToolError("a submission requires run_id");
  }
}

// Off a branch there is no run scope: a sync stays purely informational and touches NOTHING (no
// orphan marking, no log write), while a submission fails fast.
function respondOffBranch(kind: "detached" | "git-error", submitting: boolean): CallToolResult {
  if (kind === "detached") {
    if (submitting) {
      throw new WorkflowToolError("cannot submit on a detached HEAD: workflow runs are branch-scoped");
    }
    return textResult(
      "HEAD is detached: workflow runs are branch-scoped, so there is nothing to sync. " +
        "No run state was read or changed. Check out a branch and call workflow_step again.",
    );
  }
  if (submitting) {
    throw new WorkflowToolError("cannot submit: git failed to resolve the current branch");
  }
  return textResult(
    "git failed to resolve the current branch; no run state was read or changed. " +
      "Fix the repository and call workflow_step again.",
  );
}

function requireMatchingRunId(args: WorkflowStepArgs, active: ReadableRun, submitting: boolean): void {
  if (!submitting) return;
  if (args.run_id !== active.runId) {
    throw new WorkflowToolError(
      `run_id "${String(args.run_id)}" does not name this branch's unfinished run ${active.runId}`,
    );
  }
}

function buildDefinitionFromArgs(args: WorkflowStartArgs): RunDefinition {
  const documents = args.phases.map(parsePhaseDocument);
  return {
    graph: buildPhaseGraph(documents),
    steps: args.steps.map(stepDefinitionFromArgs),
    maxIterations: args.max_iterations,
  };
}

function stepDefinitionFromArgs(step: WorkflowStartArgs["steps"][number]): StepDefinition {
  if (step.on_fail.action === "rewind") {
    if (step.on_fail.to === undefined) {
      throw new WorkflowToolError(`step "${step.id}": a rewind on_fail requires "to"`);
    }
    return { id: step.id, maxAttempts: step.max_attempts, onFail: { action: "rewind", to: step.on_fail.to } };
  }
  if (step.on_fail.to !== undefined) {
    throw new WorkflowToolError(`step "${step.id}": "to" is only valid with a rewind on_fail`);
  }
  return { id: step.id, maxAttempts: step.max_attempts, onFail: { action: step.on_fail.action } };
}

function requireValidRecallAnchors(definition: RunDefinition, recallAnchors: Record<string, string[]>): void {
  for (const [phaseId, anchors] of Object.entries(recallAnchors)) {
    if (!(phaseId in definition.graph.phases)) {
      throw new WorkflowToolError(`recall_anchors names unknown phase "${phaseId}"`);
    }
    for (const anchor of anchors) {
      requireValidRecallAnchor(phaseId, anchor);
    }
  }
}

function requireValidRecallAnchor(phaseId: string, anchor: string): void {
  try {
    validateAnchor(anchor);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    throw new WorkflowToolError(`recall_anchors for phase "${phaseId}": ${problem}`);
  }
}
