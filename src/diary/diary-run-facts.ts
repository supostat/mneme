import type { z } from "zod";
import { workflowStepAppliedRestore } from "../event-schema";
import type { StoredEvent } from "../events";
import { isNoteId } from "../note";
import { restoreRuns } from "../workflow/run-events";
import type { ReadableRun } from "../workflow/run-events";
import { runIdsWithDiaryEntry } from "./diary-entries";

// The facts a retro of one finished run stands on, read off the run's own events and nothing else:
// no corpus file, no index, no git. Pure over the event log, so the tool and the CLI share it and
// neither can write by calling it. What a run's events did not record before schema v22 (the
// bundle's gap, the kinds of the notes a harvest staged) is reported as not instrumented, never
// guessed from neighbouring lines.

type StepAppliedPayload = z.infer<typeof workflowStepAppliedRestore>;

export type TerminalStatus = "complete" | "failed" | "escalated" | "abandoned" | "stale";

export interface TerminalRunRef {
  runId: string;
  status: TerminalStatus;
  diaryEntry: boolean;
}

export interface TypeCount {
  type: string;
  count: number;
}

export interface GateFailure {
  attempt: number;
  kind: "executable" | "agent-judged";
  criterion: string;
  reason: string;
  remarks: string[];
}

// stagedByType null = the harvest predates v22 and named no notes; [] = it staged none.
export type PhaseHarvest =
  | { kind: "not-run" }
  | { kind: "run"; stagedByType: TypeCount[] | null; harvestedCount: number | null; usedNotes: number | null };

export interface PhaseFacts {
  phaseId: string;
  reached: boolean;
  attempts: number;
  // null = the phase's recall application predates v22.
  bundleGap: boolean | null;
  harvest: PhaseHarvest;
  gateFailures: GateFailure[];
}

export interface CurationCounts {
  staged: number;
  accepted: number;
  rejected: number;
  superseded: number;
  uninstrumentedHarvests: number;
}

export interface RunFacts {
  runId: string;
  branch: string;
  status: TerminalStatus;
  startedTs: string;
  endedTs: string | null;
  iterationsUsed: number;
  maxIterations: number;
  diaryEntry: boolean;
  escalation: { phaseId: string; stepId: string; reason: string } | null;
  curation: CurationCounts;
  phases: PhaseFacts[];
}

export type RunFactsAnswer =
  | { kind: "facts"; facts: RunFacts }
  | { kind: "invalid-id" }
  | { kind: "unknown"; runId: string }
  | { kind: "unreadable"; runId: string; problem: string }
  | { kind: "running"; runId: string; branch: string };

const ABANDONED_EVENT = "workflow_run_abandoned";
const STALE_EVENT = "workflow_run_marked_stale";

export function runFacts(events: StoredEvent[], runId: string): RunFactsAnswer {
  if (!isNoteId(runId)) return { kind: "invalid-id" };
  const restored = restoreRuns(events).find((run) => run.runId === runId);
  if (restored === undefined) return { kind: "unknown", runId };
  if (restored.kind === "unreadable") return { kind: "unreadable", runId, problem: restored.problem };
  const ending = terminalEndingOf(events, restored);
  if (ending === null) return { kind: "running", runId, branch: restored.branch };
  const applications = stepApplicationsOf(events, runId);
  return {
    kind: "facts",
    facts: {
      runId,
      branch: restored.branch,
      status: ending.status,
      startedTs: restored.startedTs,
      endedTs: ending.ts,
      iterationsUsed: restored.run.iterationsUsed,
      maxIterations: restored.definition.maxIterations,
      diaryEntry: runIdsWithDiaryEntry(events).has(runId),
      escalation: restored.run.escalation,
      curation: curationOf(events, applications),
      phases: Object.keys(restored.definition.graph.phases).map((phaseId) =>
        phaseFactsOf(phaseId, applications.filter((application) => application.phase_id === phaseId)),
      ),
    },
  };
}

// The newest-started run of the branch that has ended — by its own status or by an abandon / stale
// marker — with whether it already has a diary entry; null when the branch has no finished run.
export function lastTerminalRunOf(events: StoredEvent[], branch: string): TerminalRunRef | null {
  const finished = restoreRuns(events).flatMap((run) => {
    if (run.kind !== "restored" || run.branch !== branch) return [];
    const ending = terminalEndingOf(events, run);
    return ending === null ? [] : [{ runId: run.runId, status: ending.status }];
  });
  const last = finished.at(-1);
  if (last === undefined) return null;
  return { ...last, diaryEntry: runIdsWithDiaryEntry(events).has(last.runId) };
}

interface TerminalEnding {
  status: TerminalStatus;
  ts: string | null;
}

// A run ends by its reducer status, or — still running by status — by a human's abandon marker or a
// stale mark for a branch that vanished. The status wins: a marker can only land on a running run.
function terminalEndingOf(events: StoredEvent[], run: ReadableRun): TerminalEnding | null {
  if (run.run.status !== "running") return { status: run.run.status, ts: run.lastActivityTs };
  const abandoned = markerOf(events, ABANDONED_EVENT, run.runId);
  if (abandoned !== undefined) return { status: "abandoned", ts: abandoned.ts };
  const stale = markerOf(events, STALE_EVENT, run.runId);
  if (stale !== undefined) return { status: "stale", ts: stale.ts };
  return null;
}

// Markers are honored on the raw run_id, exactly as the survey honors them.
function markerOf(events: StoredEvent[], type: string, runId: string): StoredEvent | undefined {
  return events.find((event) => event.type === type && event.run_id === runId);
}

// A readable run's applications all passed the restore schema already — restoreRuns would have
// marked the run unreadable otherwise — so parsing them again here cannot drop one.
function stepApplicationsOf(events: StoredEvent[], runId: string): StepAppliedPayload[] {
  return events.flatMap((event) => {
    if (event.type !== "workflow_step_applied" || event.run_id !== runId) return [];
    const parsed = workflowStepAppliedRestore.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
}

function phaseFactsOf(phaseId: string, applications: StepAppliedPayload[]): PhaseFacts {
  const executions = applications.filter((application) => application.result_kind === "execute_step");
  const recall = applications.filter((application) => application.result_kind === "recall").at(-1);
  const harvest = applications.filter((application) => application.result_kind === "harvest").at(-1);
  return {
    phaseId,
    reached: applications.length > 0,
    attempts: Math.max(0, ...executions.map((application) => application.attempt ?? 0)),
    bundleGap: recall?.gap ?? null,
    harvest: harvest === undefined ? { kind: "not-run" } : harvestOf(harvest),
    gateFailures: executions.flatMap(gateFailuresOf),
  };
}

function harvestOf(harvest: StepAppliedPayload): PhaseHarvest {
  return {
    kind: "run",
    stagedByType: harvest.staged_notes === undefined || harvest.staged_notes === null ? null : countByType(harvest.staged_notes),
    harvestedCount: harvest.harvested_n,
    usedNotes: harvest.used_notes === undefined || harvest.used_notes === null ? null : harvest.used_notes.length,
  };
}

function countByType(notes: Array<{ type: string }>): TypeCount[] {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.type, (counts.get(note.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
}

function gateFailuresOf(application: StepAppliedPayload): GateFailure[] {
  if (application.gates === null) return [];
  const attempt = application.attempt ?? 0;
  return application.gates.criteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) => {
      if (criterion.kind === "executable") {
        return { attempt, kind: criterion.kind, criterion: criterion.description, reason: criterion.reason ?? "unrecorded", remarks: [] };
      }
      const votes = criterion.votes ?? [];
      const failVotes = votes.filter((vote) => vote.vote === "fail");
      return {
        attempt,
        kind: criterion.kind,
        criterion: criterion.description,
        reason: votes.length === 0 ? "fail votes unrecorded" : `fail votes ${failVotes.length}/${votes.length}`,
        remarks: failVotes.flatMap((vote) => (vote.remarks === null ? [] : [vote.remarks])),
      };
    });
}

// The run's notes are the ones its harvests named; each one's fate is the latest human decision on
// it, and a note nobody decided on yet is still staged. A harvest from before v22 named no notes, so
// it is counted out loud instead of read as having staged none.
function curationOf(events: StoredEvent[], applications: StepAppliedPayload[]): CurationCounts {
  const harvests = applications.filter((application) => application.result_kind === "harvest");
  const noteIds = harvests.flatMap((harvest) => (harvest.staged_notes ?? []).map((note) => note.id));
  const decisions = latestDecisions(events);
  const counts: CurationCounts = {
    staged: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
    uninstrumentedHarvests: harvests.filter((harvest) => harvest.staged_notes === undefined || harvest.staged_notes === null).length,
  };
  for (const noteId of noteIds) {
    const decision = decisions.get(noteId);
    if (decision === "accept") counts.accepted += 1;
    else if (decision === "reject") counts.rejected += 1;
    else if (decision === "supersede") counts.superseded += 1;
    else counts.staged += 1;
  }
  return counts;
}

function latestDecisions(events: StoredEvent[]): Map<string, string> {
  const decisions = new Map<string, string>();
  for (const event of events) {
    if (event.type === "staging_resolve" && typeof event.note_id === "string" && typeof event.decision === "string") {
      decisions.set(event.note_id, event.decision);
    }
  }
  return decisions;
}
