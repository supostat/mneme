import type { StagingDeps } from "../staging";
import { formatGateReport, runPhaseGates, stepResultFromGateReport } from "./gate-runner";
import type { AgentJudgedCriterionResult, ExecutableCriterionResult, GateReport } from "./gate-runner";
import type { AgentVote } from "./converge";
import { MAX_INCONCLUSIVE_GATE_RUNS, stepEffectOf } from "./failure-policy";
import type { StepEffect } from "./failure-policy";
import { compileRecallBundle, formatRecallBundle, harvestPhase } from "./memory-steps";
import type { PhaseArtifact } from "./harvest-artifacts";
import { applyStepResult } from "./reducer";
import type { ExecuteStepDirective, HarvestDirective, StepResult } from "./reducer";
import { pendingDirectiveOf, phaseOf } from "./run-events";
import type { FailedGatesRecord, InconclusiveGateRecord, ReadableRun } from "./run-events";
import { stepAppliedPayload } from "./run-payloads";
import type { StepApplication, UsedNoteRef } from "./run-payloads";
import { assertDeclaredNotesInBundle } from "./used-notes";

// The mechanical side of the live executor: each function advances the in-memory run through
// applyStepResult and appends the matching workflow_step_applied event, returning the response
// sections it produced. The policy side (echo idempotency, vote placement, branch scope) stays in
// mcp-tools.ts.

export const INCONCLUSIVE_VERDICT = "INCONCLUSIVE";

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
    const bundleNotes = bundle.notes.map((note) => ({ id: note.id, type: String(note.type) }));
    active.run = applyStepResult(active.run, active.definition, result);
    // The composition is recorded HERE, at the moment it was compiled: it is what a later harvest's
    // usage declaration is checked against, and it must survive into a fresh session's fold.
    active.bundleNotesByPhase[directive.phaseId] = bundleNotes;
    appendStepApplied(deps, active, {
      result,
      attempt: null,
      gates: null,
      harvestedCount: null,
      dedupRejected: null,
      bundleNotes,
      usedNotes: null,
    });
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
  const effect = stepEffectOf(result.outcome, active.run.inconclusiveGateRuns);
  active.run = applyStepResult(active.run, active.definition, result);
  absorbGateEffect(active, pending, report, effect);
  appendStepApplied(deps, active, {
    result,
    attempt: pending.attempt,
    gates: report,
    harvestedCount: null,
    dedupRejected: null,
    bundleNotes: null,
    usedNotes: null,
  });
  const gateLabel = `${pending.phaseId}/${pending.stepId} (attempt ${pending.attempt})`;
  const verdictLines = [
    `Gate verdict for ${gateLabel}: ${verdictWordOf(effect)}`,
    ...verdictExplanation(active, pending, result, effect),
    formatGateReport(report),
  ];
  return [verdictLines.join("\n")];
}

function verdictWordOf(effect: StepEffect): string {
  if (effect === "environment-re-run") {
    return INCONCLUSIVE_VERDICT;
  }
  return effect === "success" ? "PASS" : "FAIL";
}

function verdictExplanation(
  active: ReadableRun,
  pending: ExecuteStepDirective,
  result: StepResult,
  effect: StepEffect,
): string[] {
  if (effect === "environment-re-run") {
    const reRunsLeft = MAX_INCONCLUSIVE_GATE_RUNS - active.run.inconclusiveGateRuns;
    return [
      "Every red criterion timed out, so the attempt was not consumed; " +
        `environment re-runs left: ${reRunsLeft}.`,
    ];
  }
  if (effect === "failure" && result.kind === "execute_step" && result.outcome === "inconclusive") {
    return [
      `Timeout counted as a failure: ${MAX_INCONCLUSIVE_GATE_RUNS} environment re-runs already spent on ` +
        `attempt ${pending.attempt}.`,
    ];
  }
  return [];
}

// Mirrors the restore fold's absorbGates — a pass clears the whole history, a failure appends, an
// environment re-run records what timed out and leaves the history alone — so the directive rendered
// in THIS response already carries it, without re-folding the log.
function absorbGateEffect(
  active: ReadableRun,
  pending: ExecuteStepDirective,
  report: GateReport,
  effect: StepEffect,
): void {
  if (effect === "environment-re-run") {
    active.lastInconclusiveGate = inconclusiveGateFromReport(pending, report);
    return;
  }
  active.lastInconclusiveGate = null;
  if (effect === "success") {
    active.failedGatesHistory = [];
    return;
  }
  active.failedGatesHistory.push(failedGatesFromReport(pending, report));
}

function inconclusiveGateFromReport(
  pending: ExecuteStepDirective,
  report: GateReport,
): InconclusiveGateRecord {
  const timedOut = report.criterionResults
    .filter((result): result is ExecutableCriterionResult => result.kind === "executable")
    .filter((result) => result.reason === "timeout")
    .map(({ description, durationMs, timeoutSeconds }) => {
      if (durationMs === null) {
        throw new Error(`timed-out criterion "${description}" carries no duration: gate invariant violated`);
      }
      return { description, durationMs, timeoutSeconds };
    });
  return { phaseId: pending.phaseId, stepId: pending.stepId, attempt: pending.attempt, timedOut };
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
  usedNotes?: UsedNoteRef[],
): Promise<string[]> {
  // The declaration is checked BEFORE anything is staged or appended: a call naming a note the phase
  // never surfaced is refused whole, so the corpus and the log stay exactly as they were.
  assertDeclaredNotesInBundle(pending.phaseId, usedNotes ?? [], active.bundleNotesByPhase);
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
    bundleNotes: null,
    // Absence and emptiness are recorded differently: no field means the caller was not
    // instrumented, [] means it looked and found nothing useful.
    usedNotes: usedNotes ?? null,
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
