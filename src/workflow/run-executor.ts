import type { StagingDeps } from "../staging";
import { formatGateReport, runPhaseGates, stepResultFromGateReport } from "./gate-runner";
import type { AgentJudgedCriterionResult, GateReport } from "./gate-runner";
import type { AgentVote } from "./converge";
import { compileRecallBundle, formatRecallBundle, harvestPhase } from "./memory-steps";
import type { PhaseArtifact } from "./memory-steps";
import { applyStepResult } from "./reducer";
import type { ExecuteStepDirective, HarvestDirective, StepResult } from "./reducer";
import { pendingDirectiveOf, phaseOf } from "./run-events";
import type { FailedGatesRecord, ReadableRun } from "./run-events";
import { stepAppliedPayload } from "./run-payloads";
import type { StepApplication } from "./run-payloads";

// The mechanical side of the live executor: each function advances the in-memory run through
// applyStepResult and appends the matching workflow_step_applied event, returning the response
// sections it produced. The policy side (echo idempotency, vote placement, branch scope) stays in
// mcp-tools.ts.

// Recall is the only directive the engine executes itself. It is read-only against the corpus, so a
// crash between the recall effect and its append is safe: the next call simply re-runs it.
export async function runEngineSteps(deps: StagingDeps, active: ReadableRun): Promise<string[]> {
  const sections: string[] = [];
  let directive = pendingDirectiveOf(active);
  while (directive.kind === "recall") {
    const phase = phaseOf(active.definition, directive.phaseId);
    const bundle = await compileRecallBundle(deps, {
      phaseDescription: phase.description,
      anchorPaths: active.retrieval.recallAnchors[directive.phaseId] ?? [],
      budget: active.retrieval.recallBudget,
    });
    const result: StepResult = { kind: "recall", phaseId: directive.phaseId };
    active.run = applyStepResult(active.run, active.definition, result);
    appendStepApplied(deps, active, { result, attempt: null, gates: null, harvestedCount: null, dedupRejected: null });
    sections.push(`Recall bundle for phase "${directive.phaseId}":\n${formatRecallBundle(bundle)}`);
    directive = pendingDirectiveOf(active);
  }
  return sections;
}

// Invoked only after the final step's own work succeeded (the composition rule owned by the caller):
// the gate report's verdict, not the submission, becomes the applied outcome.
export async function applyGatedFinalStep(
  deps: StagingDeps,
  active: ReadableRun,
  pending: ExecuteStepDirective,
  agentVotes: AgentVote[][],
): Promise<string[]> {
  const phase = phaseOf(active.definition, pending.phaseId);
  const report = await runPhaseGates(phase.doneWhen, { projectRoot: deps.projectRoot, agentVotes });
  const result = stepResultFromGateReport(pending.phaseId, pending.stepId, report);
  active.run = applyStepResult(active.run, active.definition, result);
  // Mirrors the restore fold's absorbGates so the retry directive rendered in THIS response already
  // carries the fail-vote remarks, without re-folding the log.
  active.lastFailedGates = report.passed ? null : failedGatesFromReport(pending, report);
  appendStepApplied(deps, active, { result, attempt: pending.attempt, gates: report, harvestedCount: null, dedupRejected: null });
  const verdict = report.passed ? "PASS" : "FAIL";
  return [
    `Gate verdict for ${pending.phaseId}/${pending.stepId} (attempt ${pending.attempt}): ${verdict}\n${formatGateReport(report)}`,
  ];
}

function failedGatesFromReport(pending: ExecuteStepDirective, report: GateReport): FailedGatesRecord {
  return {
    phaseId: pending.phaseId,
    stepId: pending.stepId,
    attempt: pending.attempt,
    failRemarks: report.criterionResults
      .filter(
        (result): result is AgentJudgedCriterionResult => result.kind === "agent-judged" && !result.passed,
      )
      .map((result) => ({
        criterionDescription: result.description,
        remarks: result.votes.flatMap((agentVote) =>
          agentVote.vote === "fail" && agentVote.remarks !== undefined && agentVote.remarks !== ""
            ? [agentVote.remarks]
            : [],
        ),
      }))
      .filter((entry) => entry.remarks.length > 0),
  };
}

// Invoked only while a harvest directive is pending (the reissue gate is owned by the caller,
// mirroring the execute_step echo gate in mcp-tools.ts).
export async function applyHarvest(
  deps: StagingDeps,
  active: ReadableRun,
  pending: HarvestDirective,
  artifacts: PhaseArtifact[],
): Promise<string[]> {
  // Crash window between harvestPhase and the append is accepted: with live embeddings a replayed
  // harvest dedups to a noop; in degraded mode the duplicate staged note is caught by human review.
  const results = await harvestPhase(deps, artifacts);
  const stagedCount = results.filter((outcome) => outcome.outcome === "staged").length;
  const rejected = results.flatMap((outcome) =>
    outcome.outcome === "noop" ? [{ nearestId: outcome.existingId, similarity: outcome.similarity }] : [],
  );
  const result: StepResult = { kind: "harvest", phaseId: pending.phaseId };
  active.run = applyStepResult(active.run, active.definition, result);
  appendStepApplied(deps, active, {
    result,
    attempt: null,
    gates: null,
    harvestedCount: stagedCount,
    dedupRejected: rejected,
  });
  const rejectionNotice =
    rejected.length === 0 ? "" : ` ${rejected.length} artifact(s) were dropped as duplicates of existing notes;`;
  return [
    `Harvested ${stagedCount} artifact(s) for phase "${pending.phaseId}";${rejectionNotice} the phase is closed.`,
  ];
}

export function appendStepApplied(deps: StagingDeps, active: ReadableRun, application: StepApplication): void {
  deps.eventWriter.append({
    ...stepAppliedPayload(active.runId, active.branch, application),
    type: "workflow_step_applied",
  });
}

export function echoMatches(
  pending: ExecuteStepDirective,
  submitted: { phase_id: string; step_id: string; attempt: number },
): boolean {
  return (
    pending.phaseId === submitted.phase_id &&
    pending.stepId === submitted.step_id &&
    pending.attempt === submitted.attempt
  );
}
