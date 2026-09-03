import { readEvents } from "../events";
import type { StagingDeps } from "../staging";
import { branchExists } from "./run-branch";
import { abandonedRunIds, restoreRuns, staleMarkedRunIds, unfinishedRunsOf } from "./run-events";
import type { ReadableRun, UnreadableRun } from "./run-events";
import { runMarkedStalePayload } from "./run-payloads";

// One survey backs every workflow tool call: it restores all runs from the log, classifies them
// relative to the current branch, and finds orphans whose branch is PROVEN missing. The survey is
// split in two halves with different rights: inspectRuns READS everything (the log, git) and writes
// nothing — orphans surface as candidates; commitStaleMarks WRITES the stale marks for those
// candidates. surveyRuns is the writing composition the run-driving tools use; a read-only tool
// calls inspectRuns alone. A mark is placed exactly once either way — already-stale runs never
// reach the orphan scan. Multiple running runs on one branch cannot be constructed through the
// tools; when the log carries them anyway, the newest started run wins and the older ones surface
// as a loud anomaly.

export interface StaleMark {
  runId: string;
  branch: string;
}

export interface RunSurvey {
  branch: string;
  activeRun: ReadableRun | null;
  supersededRunning: ReadableRun[];
  pausedRuns: ReadableRun[];
  // Orphans whose stale mark was WRITTEN by this survey (always empty after inspectRuns).
  markedStale: StaleMark[];
  // Orphans whose branch is proven missing but whose stale mark is NOT yet written (always empty
  // after surveyRuns): the next writing survey will mark them.
  orphanCandidates: StaleMark[];
  indeterminateRuns: ReadableRun[];
  staleRunsOfBranch: ReadableRun[];
  unreadableRuns: UnreadableRun[];
  lastTerminalRun: ReadableRun | null;
}

export async function inspectRuns(deps: StagingDeps, branch: string): Promise<RunSurvey> {
  const events = readEvents(deps.corpus.eventsDir);
  const runs = restoreRuns(events);
  const staleRunIds = staleMarkedRunIds(events);
  const abandonedIds = abandonedRunIds(events);
  // An abandoned run is terminal by marker: it leaves every live listing — including the stale
  // listing of its branch — before the orphan scan, so it is never branch-checked again.
  const unfinished = unfinishedRunsOf(runs, new Set([...staleRunIds, ...abandonedIds]));
  const verdicts = await classifyOrphans(deps, unfinished.filter((run) => run.branch !== branch));
  const runningHere = unfinished.filter((run) => run.branch === branch);
  const terminalHere = runs.filter(
    (run): run is ReadableRun =>
      run.kind === "restored" && run.branch === branch && run.run.status !== "running",
  );
  return {
    branch,
    activeRun: runningHere.at(-1) ?? null,
    supersededRunning: runningHere.slice(0, -1),
    pausedRuns: verdicts.paused,
    markedStale: [],
    orphanCandidates: verdicts.orphanCandidates,
    indeterminateRuns: verdicts.indeterminate,
    staleRunsOfBranch: runs.filter(
      (run): run is ReadableRun =>
        run.kind === "restored" &&
        run.branch === branch &&
        staleRunIds.has(run.runId) &&
        !abandonedIds.has(run.runId),
    ),
    unreadableRuns: runs.filter((run): run is UnreadableRun => run.kind === "unreadable"),
    lastTerminalRun: terminalHere.at(-1) ?? null,
  };
}

export function commitStaleMarks(deps: StagingDeps, candidates: StaleMark[]): StaleMark[] {
  for (const candidate of candidates) {
    deps.eventWriter.append({
      ...runMarkedStalePayload(candidate.runId, candidate.branch),
      type: "workflow_run_marked_stale",
    });
  }
  return candidates.map((candidate) => ({ runId: candidate.runId, branch: candidate.branch }));
}

export async function surveyRuns(deps: StagingDeps, branch: string): Promise<RunSurvey> {
  const inspected = await inspectRuns(deps, branch);
  return {
    ...inspected,
    markedStale: commitStaleMarks(deps, inspected.orphanCandidates),
    orphanCandidates: [],
  };
}

interface OrphanVerdicts {
  paused: ReadableRun[];
  orphanCandidates: StaleMark[];
  indeterminate: ReadableRun[];
}

async function classifyOrphans(deps: StagingDeps, otherBranchRuns: ReadableRun[]): Promise<OrphanVerdicts> {
  const verdicts: OrphanVerdicts = { paused: [], orphanCandidates: [], indeterminate: [] };
  // Branch checks stay strictly sequential: unbounded parallel git spawns are a named debt.
  for (const run of otherBranchRuns) {
    const existence = await branchExists(deps.projectRoot, run.branch);
    if (existence === "exists") {
      verdicts.paused.push(run);
    } else if (existence === "missing") {
      verdicts.orphanCandidates.push({ runId: run.runId, branch: run.branch });
    } else {
      // indeterminate: git could not answer, so the run is warned about but NEVER marked stale.
      verdicts.indeterminate.push(run);
    }
  }
  return verdicts;
}
