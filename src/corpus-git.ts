import type { Corpus } from "./corpus";
import { runGit } from "./git";
import type { GitResult } from "./git";

// The ONE path a change takes into the corpus's git history, shared by staging resolution and spec
// migration so a second commit mechanic never drifts from the first. Identity is pinned per
// invocation (-c), never read from the user's config, so commits work on machines with no git
// identity at all. `diff --cached --quiet` over the same paths cuts empty commits: a byte-identical
// re-run stages nothing new and returns the existing HEAD instead of minting one.

export class CorpusGitError extends Error {}

const COMMIT_AUTHOR_ARGS = ["-c", "user.email=mneme@localhost", "-c", "user.name=mneme"];

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
    throw new CorpusGitError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}
