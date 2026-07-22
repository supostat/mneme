import type { WORKFLOW_STALE_REASONS } from "../event-schema";
import type { StepDefinition } from "./failure-policy";
import type { GateReport } from "./gate-runner";
import type { PhaseDocument } from "./phase-document";
import type { RunDefinition, StepResult } from "./reducer";
import type { RunRetrievalConfig } from "./run-events";

// Producer-side serialization of workflow run events. Payloads NEVER carry a "type" key — the event
// envelope owns it — and every payload names its branch (runs are branch-scoped by ADR). The consumer
// fold lives in run-events.ts; both sides ship in the same change by the producer+consumer rule.

const STALE_REASON_BRANCH_NOT_FOUND: (typeof WORKFLOW_STALE_REASONS)[number] = "branch_not_found";

export interface DedupRejection {
  nearestId: string;
  similarity: number;
}

export interface StepApplication {
  result: StepResult;
  attempt: number | null;
  gates: GateReport | null;
  harvestedCount: number | null;
  dedupRejected: DedupRejection[] | null;
}

export function runStartedPayload(
  runId: string,
  branch: string,
  definition: RunDefinition,
  retrieval: RunRetrievalConfig,
): Record<string, unknown> {
  return { run_id: runId, branch, definition: definitionToPayload(definition, retrieval) };
}

export function stepAppliedPayload(
  runId: string,
  branch: string,
  application: StepApplication,
): Record<string, unknown> {
  const result = application.result;
  return {
    run_id: runId,
    branch,
    phase_id: result.phaseId,
    result_kind: result.kind,
    step_id: result.kind === "execute_step" ? result.stepId : null,
    outcome: result.kind === "execute_step" ? result.outcome : null,
    attempt: application.attempt,
    gates: application.gates === null ? null : gateReportPayload(application.gates),
    harvested_n: application.harvestedCount,
    dedup_rejected:
      application.dedupRejected === null
        ? null
        : application.dedupRejected.map((rejection) => ({
            nearest_id: rejection.nearestId,
            similarity: rejection.similarity,
          })),
  };
}

export function runMarkedStalePayload(runId: string, branch: string): Record<string, unknown> {
  return { run_id: runId, branch, reason: STALE_REASON_BRANCH_NOT_FOUND };
}

export function runAbandonedPayload(runId: string, branch: string, reason: string): Record<string, unknown> {
  return { run_id: runId, branch, reason };
}

function definitionToPayload(
  definition: RunDefinition,
  retrieval: RunRetrievalConfig,
): Record<string, unknown> {
  return {
    phases: Object.values(definition.graph.phases).map(phaseToPayload),
    steps: definition.steps.map(stepToPayload),
    max_iterations: definition.maxIterations,
    recall_budget: retrieval.recallBudget,
    recall_anchors: retrieval.recallAnchors,
  };
}

function phaseToPayload(document: PhaseDocument): Record<string, unknown> {
  return {
    id: document.id,
    deps: document.deps,
    agent_role: document.agentRole,
    description: document.description,
    tasks: document.tasks,
    done_when: document.doneWhen.map((criterion) => ({
      kind: criterion.kind,
      description: criterion.description,
      command: criterion.kind === "executable" ? criterion.command : null,
    })),
  };
}

function stepToPayload(step: StepDefinition): Record<string, unknown> {
  return {
    id: step.id,
    max_attempts: step.maxAttempts,
    on_fail: { action: step.onFail.action, to: step.onFail.action === "rewind" ? step.onFail.to : null },
  };
}

function gateReportPayload(report: GateReport): Record<string, unknown> {
  return {
    passed: report.passed,
    executable_n: report.executableCount,
    agent_judged_n: report.agentJudgedCount,
    criteria: report.criterionResults.map((result) => ({
      kind: result.kind,
      description: result.description,
      passed: result.passed,
      reason: result.kind === "executable" ? result.reason : null,
      votes:
        result.kind === "agent-judged"
          ? result.votes.map((agentVote) => ({ vote: agentVote.vote, remarks: agentVote.remarks ?? null }))
          : null,
    })),
  };
}
