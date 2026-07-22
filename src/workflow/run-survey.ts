import { readEvents } from "../events";
import type { StagingDeps } from "../staging";
import { branchExists } from "./run-branch";
import { abandonedRunIds, restoreRuns, staleMarkedRunIds, unfinishedRunsOf } from "./run-events";
import type { ReadableRun, UnreadableRun } from "./run-events";
import { runMarkedStalePayload } from "./run-payloads";

// One survey backs every workflow tool call: it restores all runs from the log, marks orphans whose
// branch is PROVEN missing as stale (exactly once — already-stale runs never reach the orphan scan),
// and classifies the rest relative to the current branch. Multiple running runs on one branch cannot
// be constructed through the tools; when the log carries them anyway, the newest started run wins and
// the older ones surface as a loud anomaly.

export interface StaleMark {
  runId: string;
  branch: string;
}

export interface RunSurvey {
  branch: string;
  activeRun: ReadableRun | null;
  supersededRunning: ReadableRun[];
  pausedRuns: ReadableRun[];
  markedStale: StaleMark[];
  indeterminateRuns: ReadableRun[];
  staleRunsOfBranch: ReadableRun[];
  unreadableRuns: UnreadableRun[];
  lastTerminalRun: ReadableRun | null;
}

export async function surveyRuns(deps: StagingDeps, branch: string): Promise<RunSurvey> {
  const events = readEvents(deps.corpus.eventsDir);
  const runs = restoreRuns(events);
  const staleRunIds = staleMarkedRunIds(events);
  const abandonedIds = abandonedRunIds(events);
  // An abandoned run is terminal by marker: it leaves every live listing — including the stale
  // listing of its branch — before the orphan scan, so it is never branch-checked again.
  const unfinished = unfinishedRunsOf(runs, new Set([...staleRunIds, ...abandonedIds]));
  const verdicts = await markOrphans(deps, unfinished.filter((run) => run.branch !== branch));
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
    markedStale: verdicts.markedStale,
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

interface OrphanVerdicts {
  paused: ReadableRun[];
  markedStale: StaleMark[];
  indeterminate: ReadableRun[];
}

async function markOrphans(deps: StagingDeps, otherBranchRuns: ReadableRun[]): Promise<OrphanVerdicts> {
  const verdicts: OrphanVerdicts = { paused: [], markedStale: [], indeterminate: [] };
  // Branch checks stay strictly sequential: unbounded parallel git spawns are a named debt.
  for (const run of otherBranchRuns) {
    const existence = await branchExists(deps.projectRoot, run.branch);
    if (existence === "exists") {
      verdicts.paused.push(run);
    } else if (existence === "missing") {
      deps.eventWriter.append({
        ...runMarkedStalePayload(run.runId, run.branch),
        type: "workflow_run_marked_stale",
      });
      verdicts.markedStale.push({ runId: run.runId, branch: run.branch });
    } else {
      // indeterminate: git could not answer, so the run is warned about but NEVER marked stale.
      verdicts.indeterminate.push(run);
    }
  }
  return verdicts;
}
