import { DEAD_ANCHOR_SINK } from "./fusion";
import { runGit } from "./git";
import { livenessOf } from "./anchor-liveness";
import type { LivenessContext } from "./anchor-liveness";
import type { CommitBase } from "./commit-base";

export { isTracked } from "./anchor-liveness";
// The dead-anchor value is the fusion comparator's class boundary, so it is declared beside the
// comparator and only re-exported here for the liveness code and its callers.
export { DEAD_ANCHOR_SINK } from "./fusion";

export const DRIFT_PENALTY_PER_COMMIT = -0.001;
export const DRIFT_PENALTY_CAP = -0.01;
// "Alive, just not here": a path parked on another branch's tip ranks like a maximally drifted
// anchor, never like a dead one. The VALUE matches the drift cap today, but it is its own pinned
// constant — the semantics differ, so the two must stay free to diverge.
export const KNOWN_ELSEWHERE_PENALTY = -0.01;
// "Alive, base lost": a tracked anchor whose commit is gone with no known copy cannot count its
// drift, so it ranks like a maximally drifted anchor, never like a dead one. Its own pinned
// constant for the same reason as KNOWN_ELSEWHERE_PENALTY.
export const UNRESOLVED_BASE_PENALTY = -0.01;

export async function stalenessBoost(
  context: LivenessContext,
  anchors: string[],
  base: CommitBase,
): Promise<number> {
  const perAnchor = await Promise.all(
    anchors.map((anchor) => anchorBoost(context, anchor, base)),
  );
  return Math.min(...perAnchor);
}

// The boost derives from the SAME four-state classification the staging warning and the sweep
// read: tracked earns drift from the commit base, known-elsewhere earns the parked penalty,
// everything else keeps the dead-anchor sink (untracked-exists behavior is unchanged by design).
async function anchorBoost(context: LivenessContext, anchor: string, base: CommitBase): Promise<number> {
  const resolved = await livenessOf(context, anchor);
  if (resolved.liveness === "tracked") {
    return base.kind === "unresolved"
      ? UNRESOLVED_BASE_PENALTY
      : driftPenalty(context.projectRoot, anchor, base.commit);
  }
  if (resolved.liveness === "known-elsewhere") {
    return KNOWN_ELSEWHERE_PENALTY;
  }
  return DEAD_ANCHOR_SINK;
}

async function driftPenalty(projectRoot: string, anchor: string, commit: string): Promise<number> {
  const result = await runGit(projectRoot, ["rev-list", "--count", `${commit}..HEAD`], [anchor]);
  if (result.exitCode !== 0) {
    return DEAD_ANCHOR_SINK;
  }
  const commitsSince = Number.parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(commitsSince)) {
    return DEAD_ANCHOR_SINK;
  }
  if (commitsSince === 0) {
    return 0;
  }
  return Math.max(commitsSince * DRIFT_PENALTY_PER_COMMIT, DRIFT_PENALTY_CAP);
}
