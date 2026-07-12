import type { PhaseGraph, PhaseStatus } from "./phase-graph";
import type { StepDefinition } from "./failure-policy";

// The plain JSON-serializable state and message types of the workflow reducer, restorable by folding
// StepResults through applyStepResult. Declarations live apart from reducer.ts solely for the
// 300-line file cap; reducer.ts re-exports them and remains the module callers import.

export interface RunDefinition {
  graph: PhaseGraph;
  steps: StepDefinition[];
  maxIterations: number;
}

export type RunStatus = "running" | "complete" | "failed" | "escalated";

export interface RunEscalation {
  phaseId: string;
  stepId: string;
  reason: string;
}

export interface WorkflowRun {
  status: RunStatus;
  phaseStatuses: Record<string, PhaseStatus>;
  activePhaseId: string | null;
  stepIndex: number;
  stepAttempts: number[];
  iterationsUsed: number;
  failureReason: string | null;
  escalation: RunEscalation | null;
}

export interface ExecuteStepDirective {
  kind: "execute_step";
  phaseId: string;
  stepId: string;
  agentRole: string;
  attempt: number;
}

export interface RecallDirective {
  kind: "recall";
  phaseId: string;
}

export interface HarvestDirective {
  kind: "harvest";
  phaseId: string;
}

export type Directive =
  | ExecuteStepDirective
  | RecallDirective
  | HarvestDirective
  | { kind: "run_complete" }
  | { kind: "run_failed"; reason: string }
  | { kind: "escalate"; phaseId: string; stepId: string; reason: string };

export interface ExecuteStepResult {
  kind: "execute_step";
  phaseId: string;
  stepId: string;
  outcome: "success" | "failure";
}

export interface RecallStepResult {
  kind: "recall";
  phaseId: string;
}

export interface HarvestStepResult {
  kind: "harvest";
  phaseId: string;
}

export type StepResult = ExecuteStepResult | RecallStepResult | HarvestStepResult;
