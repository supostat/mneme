import type { Corpus } from "./corpus";
import { runGit } from "./git";
import type { GitResult } from "./git";

// The ONE path a change takes into the corpus's git history, shared by staging resolution and spec
// migration so a second commit mechanic never drifts from the first. Identity is pinned per
// invocation (-c), never read from the user's config, so commits work on machines with no git
// identity at all. `diff --cached --quiet` over the same paths cuts empty commits: a byte-identical
// re-run stages nothing new and returns the existing HEAD instead of minting one.

export class CorpusGitError extends Error {}

// A shared corpus has more than one live session, and git serializes writers with .git/index.lock:
// the loser gets a generic non-zero exit whose real meaning is "someone else is mid-commit". It is
// raised as a DISTINCT error (a CorpusGitError, so existing handling still catches it) rather than
// retried blindly — every corpus writer is retry-convergent, so the honest move is to tell the
// caller to run the same operation again.
export class CorpusBusyError extends CorpusGitError {}

const COMMIT_AUTHOR_ARGS = ["-c", "user.email=mneme@localhost", "-c", "user.name=mneme"];
const INDEX_LOCK_MARKER = "index.lock";

export async function commitPaths(
  corpus: Corpus,
  relativePaths: string[],
  subject: string,
): Promise<string> {
  await runGitOrThrow(corpus.corpusDir, ["add"], relativePaths);
  const staged = await runGit(corpus.corpusDir, ["diff", "--cached", "--quiet"], relativePaths);
  if (staged.exitCode !== 0) {
    await runGitOrThrow(corpus.corpusDir, [...COMMIT_AUTHOR_ARGS, "commit", "-q", "-m", subject]);
  }
  const head = await runGitOrThrow(corpus.corpusDir, ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}

async function runGitOrThrow(
  repoDir: string,
  args: string[],
  pathArgs: string[] = [],
): Promise<GitResult> {
  const result = await runGit(repoDir, args, pathArgs);
  if (result.exitCode !== 0) {
    if (result.stderr.includes(INDEX_LOCK_MARKER)) {
      throw new CorpusBusyError("another session is committing to this corpus; retry");
    }
    throw new CorpusGitError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}
