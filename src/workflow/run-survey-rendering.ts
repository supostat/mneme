import { describePending, joinSections, surveySections } from "./run-directives";
import { pendingDirectiveOf } from "./run-events";
import type { ReadableRun } from "./run-events";
import type { RunSurvey } from "./run-survey";

// Renders the read-only survey tool's two shapes: the orientation MAP (what a resuming agent needs
// to know where the branch's work stands) and the one-line BRIEF (what a session-start hook can
// print). Both derive from one inspectRuns result and reuse the survey sections the run-driving
// tools already render, so the survey never describes state differently from the next step call.

const READ_ONLY_NOTICE = "Nothing was written: no event, no file, no stale mark.";

export function renderSurveyMap(survey: RunSurvey, stagedNoteCount: number): string {
  return joinSections([
    `Survey of branch "${survey.branch}". ${READ_ONLY_NOTICE}`,
    survey.activeRun === null
      ? `No unfinished workflow run on branch "${survey.branch}".`
      : renderActiveRun(survey.activeRun),
    `Staged notes awaiting review: ${stagedNoteCount}`,
    ...surveySections(survey),
    renderOrphanCandidates(survey),
    renderLastTerminalRun(survey),
    renderStaleRunsOfBranch(survey),
  ]);
}

export function renderSurveyLine(survey: RunSurvey, stagedNoteCount: number): string {
  if (survey.activeRun === null) {
    const elsewhere = survey.pausedRuns.length > 0 ? ` · ${survey.pausedRuns.length} live elsewhere` : "";
    return `${survey.branch} · no unfinished run · staged ${stagedNoteCount}${elsewhere}`;
  }
  const active = survey.activeRun;
  return (
    `${survey.branch} · run ${active.runId} [${active.run.status}] · phase ${phaseLabel(active)} ` +
    `[${describePending(pendingDirectiveOf(active))}] · staged ${stagedNoteCount} · last ${active.lastActivityTs}`
  );
}

// Off a branch there is nothing branch-scoped to survey; the answer is informational and, like
// every other survey answer, writes nothing — never an error, because an error would be logged.
export function renderSurveyOffBranch(kind: "detached" | "git-error"): string {
  if (kind === "detached") {
    return (
      "HEAD is detached: workflow runs are branch-scoped, so there is no branch to survey. " +
      "No run state was read or changed."
    );
  }
  return "git failed to resolve the current branch; no run state was read or changed.";
}

function renderActiveRun(active: ReadableRun): string {
  return [
    `Active run ${active.runId} status=${active.run.status} ` +
      `iterations=${active.run.iterationsUsed}/${active.definition.maxIterations}`,
    `started ${active.startedTs} · last activity ${active.lastActivityTs}`,
    `phase ${phaseLabel(active)} · ${describePending(pendingDirectiveOf(active))}`,
  ].join("\n");
}

// The phase the run is on is the one its pending directive names; a terminal directive names none.
function phaseLabel(active: ReadableRun): string {
  const directive = pendingDirectiveOf(active);
  return "phaseId" in directive ? directive.phaseId : (active.run.activePhaseId ?? "-");
}

function renderOrphanCandidates(survey: RunSurvey): string {
  if (survey.orphanCandidates.length === 0) {
    return "";
  }
  const lines = ["ORPHAN CANDIDATES (not yet marked):"];
  for (const candidate of survey.orphanCandidates) {
    lines.push(
      `- run ${candidate.runId} on branch "${candidate.branch}": branch not found — ` +
        "the next workflow_start/workflow_step will mark it stale.",
    );
  }
  return lines.join("\n");
}

function renderLastTerminalRun(survey: RunSurvey): string {
  if (survey.lastTerminalRun === null) {
    return "";
  }
  return `Last terminal run on this branch: ${survey.lastTerminalRun.runId} [${survey.lastTerminalRun.run.status}].`;
}

function renderStaleRunsOfBranch(survey: RunSurvey): string {
  if (survey.staleRunsOfBranch.length === 0) {
    return "";
  }
  return `Stale runs on this branch: ${survey.staleRunsOfBranch.length} (never resumable).`;
}
