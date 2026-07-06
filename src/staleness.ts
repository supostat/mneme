import { runGit } from "./git";

export const DEAD_ANCHOR_SINK = -1;
export const DRIFT_PENALTY_PER_COMMIT = -0.001;
export const DRIFT_PENALTY_CAP = -0.01;

export async function stalenessBoost(
  projectRoot: string,
  anchors: string[],
  commit: string,
): Promise<number> {
  const perAnchor = await Promise.all(
    anchors.map((anchor) => anchorBoost(projectRoot, anchor, commit)),
  );
  return Math.min(...perAnchor);
}

async function anchorBoost(projectRoot: string, anchor: string, commit: string): Promise<number> {
  if (!(await isTracked(projectRoot, anchor))) {
    return DEAD_ANCHOR_SINK;
  }
  return driftPenalty(projectRoot, anchor, commit);
}

async function isTracked(projectRoot: string, anchor: string): Promise<boolean> {
  const result = await runGit(projectRoot, ["ls-files", "--error-unmatch"], [anchor]);
  return result.exitCode === 0;
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
