import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AGENT_VOTE_VALUES, WORKFLOW_ON_FAIL_ACTIONS, WORKFLOW_STEP_OUTCOMES } from "../event-schema";
import { readEvents } from "../events";
import { textResult } from "../mcp-rendering";
import { validateAnchor } from "../note";
import { countStagedNotes } from "../staging";
import type { StagingDeps } from "../staging";
import type { AgentVote, Vote } from "./converge";
import type { StepDefinition } from "./failure-policy";
import { phaseDocumentsFromSpec } from "./from-spec";
import type { PhaseArtifact } from "./memory-steps";
import { applyMigration, planMigration, specSlug } from "./migration";
import type { MigrationPlan, MigrationReport } from "./migration";
import {
  conflictingPhaseIds,
  createdAbsolutePaths,
  renderMigrationManifest,
  renderPathList,
  renderPhaseGraph,
  renderRunCommand,
} from "./migration-rendering";
import { containsForbiddenCharacter, parsePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";
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
import { abandonedRunIds, isFinalStep, pendingDirectiveOf, restoreRuns } from "./run-events";
import type { ReadableRun, RunRetrievalConfig } from "./run-events";
import { appendStepApplied, applyGatedFinalStep, applyHarvest, echoMatches, runEngineSteps } from "./run-executor";
import { runAbandonedPayload, runStartedPayload } from "./run-payloads";
import { surveyRuns } from "./run-survey";

export class WorkflowToolError extends Error {}

export const DEFAULT_WORKFLOW_RECALL_BUDGET = 2000;

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
  "phase's FINAL step succeeds - send agent_votes (one array per agent-judged criterion; a vote is " +
  '"pass"|"fail" or { vote, remarks }, and remarks of fail votes are replayed into the retry directive) ' +
  "with that submission; a failure never runs gates. When a harvest directive is pending, submit " +
  "harvest_artifacts (an empty array is allowed) to close the phase.";
export const WORKFLOW_ABANDON_DESCRIPTION =
  "Abandon an unfinished workflow run by run_id: a terminal human refusal, distinct from failure. " +
  "The run leaves every survey listing and can NEVER be resumed; its branch is untouched and a new " +
  "run can be started there at any time. Abandoning an already-abandoned run is a no-op that " +
  "appends nothing; abandoning an unknown run or a run that already reached a terminal is an error.";
export const WORKFLOW_MIGRATE_DESCRIPTION =
  "Convert a spec's # Gameplan into workflow phase files under this project's corpus " +
  "(<corpusDir>/workflow/<spec-slug>/), so the phases of one task live together. DRY-RUN by default: " +
  "it classifies every target as create, identical or conflict and writes NOTHING; pass apply: true " +
  "to perform the writes. A target that diverges from an existing file is a CONFLICT that refuses the " +
  "whole migration - resolve it by hand, there is no force flag. A byte-identical target is skipped, " +
  "so re-migrating an unchanged spec is idempotent. Both responses carry the phase graph (id, deps, " +
  "done-when kinds); apply also carries the written paths and the /mneme:dev command that runs them.";

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

export const WORKFLOW_MIGRATE_INPUT = {
  spec_path: z.string(),
  apply: z.boolean().optional(),
};

export const WORKFLOW_ABANDON_INPUT = {
  run_id: z.string(),
  reason: z.string(),
};

// The tool boundary accepts BOTH vote shapes: the bare "pass"|"fail" enum (every pre-remarks caller
// stays valid) and the enriched { vote, remarks? } object. Normalization to the canonical AgentVote
// happens once, here, so the engine below this boundary knows exactly one shape.
const submittedAgentVote = z.union([
  z.enum(AGENT_VOTE_VALUES),
  z.object({ vote: z.enum(AGENT_VOTE_VALUES), remarks: z.string().optional() }),
]);

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
  agent_votes: z.array(z.array(submittedAgentVote).min(1)).optional(),
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

export type SubmittedAgentVote = Vote | { vote: Vote; remarks?: string };

export interface WorkflowStepArgs {
  run_id?: string;
  step_result?: SubmittedStepResult;
  agent_votes?: SubmittedAgentVote[][];
  harvest_artifacts?: PhaseArtifact[];
}

export interface WorkflowMigrateArgs {
  spec_path: string;
  apply?: boolean;
}

export interface WorkflowAbandonArgs {
  run_id: string;
  reason: string;
}

// Abandonment targets a run WHEREVER its branch lives: the current checkout is irrelevant, so the
// tool never touches git — the event names the branch the run itself was anchored to. Idempotency
// mirrors the submission gates: a repeated abandon changes nothing and appends nothing.
export function workflowAbandonTool(deps: StagingDeps, args: WorkflowAbandonArgs): CallToolResult {
  requireCleanSingleLine(args.reason, "abandon reason");
  const events = readEvents(deps.corpus.eventsDir);
  if (abandonedRunIds(events).has(args.run_id)) {
    return textResult(`Run ${args.run_id} is already abandoned; nothing was appended.`);
  }
  const target = restoreRuns(events).find((run) => run.runId === args.run_id);
  if (target === undefined) {
    throw new WorkflowToolError(`no workflow run "${args.run_id}" exists in the event log`);
  }
  if (target.kind === "unreadable") {
    throw new WorkflowToolError(
      `run ${args.run_id} is unreadable (${target.problem}); an unreadable run cannot be abandoned`,
    );
  }
  if (target.run.status !== "running") {
    throw new WorkflowToolError(
      `run ${args.run_id} already reached a terminal (${target.run.status}); only unfinished runs can be abandoned`,
    );
  }
  deps.eventWriter.append({
    ...runAbandonedPayload(target.runId, target.branch, args.reason),
    type: "workflow_run_abandoned",
  });
  return textResult(
    [
      `Run ${target.runId} [branch "${target.branch}"] is abandoned: ${args.reason}`,
      "Abandoned is terminal — the run leaves the survey and can never be resumed. " +
        "Start a new run with workflow_start when the work still matters.",
    ].join("\n"),
  );
}

// A thin entry over the 12a persistence library: read the spec, generate its phase documents, plan
// the writes into this project's corpus, and either render the plan (dry-run, the safe default) or
// apply it. All classification, atomicity and conflict policy stay in migration.ts.
export function workflowMigrateTool(deps: StagingDeps, args: WorkflowMigrateArgs): CallToolResult {
  const specPath = resolve(deps.projectRoot, args.spec_path);
  const documents = phaseDocumentsFromSpec(readSpec(specPath));
  const plan = planMigration(documents, deps.corpus.corpusDir, specSlug(specPath));
  if (args.apply !== true) {
    return textResult(renderMigrationDryRun(plan, documents));
  }
  requireNoConflictingPhases(plan);
  return textResult(renderMigrationApplied(plan, applyMigration(plan), documents));
}

function readSpec(specPath: string): string {
  try {
    return readFileSync(specPath, "utf8");
  } catch {
    throw new WorkflowToolError(`cannot read the spec at ${specPath}`);
  }
}

// Conflicts are named by PHASE, not by path: the caller edits phases, so the phase id is the handle
// it can act on. This refusal fires before applyMigration, whose own guard (plus its TOCTOU
// re-classify) remains the fail-closed floor if the disk changes underneath.
function requireNoConflictingPhases(plan: MigrationPlan): void {
  const conflicts = conflictingPhaseIds(plan);
  if (conflicts.length === 0) {
    return;
  }
  throw new WorkflowToolError(
    `refusing to migrate: ${conflicts.length} phase file(s) diverge from an existing file: ` +
      `${conflicts.join(", ")}. Migration never overwrites; resolve each by hand, there is no force.`,
  );
}

function renderMigrationDryRun(plan: MigrationPlan, documents: PhaseDocument[]): string {
  const conflicts = conflictingPhaseIds(plan);
  const closing =
    conflicts.length > 0
      ? `Nothing was written. apply would REFUSE: ${conflicts.length} phase file(s) diverge from an ` +
        `existing file: ${conflicts.join(", ")}.`
      : "Nothing was written. Call workflow_migrate again with apply: true to write these files.";
  return joinSections([
    renderMigrationManifest(plan),
    renderPathList("Full paths (dry-run):", plan.writes.map((write) => write.absolutePath)),
    renderPhaseGraph(documents),
    closing,
  ]);
}

function renderMigrationApplied(
  plan: MigrationPlan,
  report: MigrationReport,
  documents: PhaseDocument[],
): string {
  const created = createdAbsolutePaths(plan, report);
  return joinSections([
    `Migrated into ${plan.workflowDir}: wrote ${report.created.length}, skipped ${report.skipped.length} identical.`,
    created.length > 0 ? renderPathList("Created:", created) : "",
    renderPhaseGraph(documents),
    renderRunCommand(plan),
  ]);
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
  // Lazy recall: pending recalls are compiled ONLY here, at the START of a call, so a phase's bundle
  // is built when the phase BEGINS — after any human accept made at the preceding boundary — never
  // eagerly when the previous phase closed. This drains a recall left pending by start, resume, or a
  // prior phase boundary.
  sections.push(...(await runEngineSteps(deps, active)));
  if (args.step_result !== undefined) {
    sections.push(...(await applyIncomingStepResult(deps, active, args.step_result, args.agent_votes)));
  } else if (args.harvest_artifacts !== undefined) {
    sections.push(...(await applyIncomingHarvest(deps, active, args.harvest_artifacts)));
  }
  // A harvest that opens the next phase leaves its recall PENDING here, NOT executed: renderCurrentDirective
  // renders that pending recall as a phase boundary, so the caller loops with another workflow_step to
  // begin the next phase — the call break where a human can accept staged notes into the next bundle.
  return textResult(
    joinSections([
      renderRunHeader(active),
      ...sections,
      renderCurrentDirective(active, countStagedNotes(deps.corpus)),
      ...surveySections(survey),
    ]),
  );
}

// Echo idempotency: a submission that does not exactly restate the pending execute_step directive
// (phase, step, attempt) changes nothing and re-issues the directive; only a matching final-step
// success reaches the gates.
async function applyIncomingStepResult(
  deps: StagingDeps,
  active: ReadableRun,
  submitted: SubmittedStepResult,
  agentVotes: SubmittedAgentVote[][] | undefined,
): Promise<string[]> {
  const pending = pendingDirectiveOf(active);
  if (pending.kind !== "execute_step" || !echoMatches(pending, submitted)) {
    return [renderReissueNotice(describePending(pending))];
  }
  if (submitted.outcome === "success" && isFinalStep(active.definition, active.run)) {
    return applyGatedFinalStep(deps, active, pending, normalizeAgentVotes(agentVotes ?? []));
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
  appendStepApplied(deps, active, { result, attempt: pending.attempt, gates: null, harvestedCount: null, dedupRejected: null });
  return [`Applied ${submitted.outcome} for ${pending.phaseId}/${pending.stepId} (attempt ${pending.attempt}); gates were not run.`];
}

// The single validation point for remarks, at the boundary where both submitted shapes converge:
// what the one-line-per-remark directive frame cannot carry (line breaks, the invisible-character
// class every sibling channel already refuses) and what carries no information (blank text) is
// rejected HERE, never silently dropped downstream.
function normalizeAgentVotes(votes: SubmittedAgentVote[][]): AgentVote[][] {
  return votes.map((voteArray) =>
    voteArray.map((submitted) => {
      if (typeof submitted === "string") {
        return { vote: submitted };
      }
      if (submitted.remarks !== undefined) {
        requireCleanSingleLine(submitted.remarks, "vote remarks");
      }
      return submitted;
    }),
  );
}

// The one-line contract shared by every free-text field that travels into directive frames and log
// events: blank text carries no information, and line breaks or invisible characters would break
// the one-line-per-entry render downstream.
function requireCleanSingleLine(text: string, subject: string): void {
  if (text.trim() === "") {
    throw new WorkflowToolError(`${subject} must not be blank`);
  }
  if (text.includes("\n") || containsForbiddenCharacter(text)) {
    throw new WorkflowToolError(
      `${subject} must be a single line free of control and invisible characters`,
    );
  }
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
