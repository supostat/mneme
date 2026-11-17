import { runGit } from "../git";

// The project HEAD a run starts from — the base a later diff separates the run's commits from the
// ones before it. A repository without commits is a legitimate place to start a run, so it answers
// "none" rather than failing the way resolveHead does for writes that must pin a commit; only exit 1
// with an empty answer means "no such revision" (git exits 128 for a directory it cannot read as a
// repository), and every other failure is reported as a git error for the caller to refuse on.

export type BaseCommitResolution = { kind: "commit"; sha: string } | { kind: "no-commits" } | { kind: "git-error" };

const NO_SUCH_REVISION_EXIT = 1;

export async function resolveBaseCommit(projectRoot: string): Promise<BaseCommitResolution> {
  const result = await runGit(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (result.exitCode === 0) return { kind: "commit", sha: result.stdout.trim() };
  if (result.exitCode === NO_SUCH_REVISION_EXIT && result.stdout.trim() === "") return { kind: "no-commits" };
  return { kind: "git-error" };
}
