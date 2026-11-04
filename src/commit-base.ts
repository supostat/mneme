import { COMMIT_RECORD_ARGS, parseCommitRecords, readLiveCommitIdentities } from "./commit-identity";
import type { CommitRecord } from "./commit-identity";
import { runGit } from "./git";

// Where the drift of a pinned commit is measured on the current HEAD — the one answer staleness and
// the bundle's branch layer read, so neither asks git about a note's commit on its own:
// - on-head: the commit is in HEAD's history;
// - copy: a rebase rewrote it, and exactly one commit of HEAD's history carries its identity;
// - off-head: the object is alive but HEAD holds neither it nor one copy (a parallel branch, a
//   squash merge, an ambiguous identity);
// - unresolved: the object is gone and no copy is known — the base is lost, not the anchor.
export type CommitBase =
  | { kind: "on-head"; commit: string }
  | { kind: "copy"; commit: string }
  | { kind: "off-head"; commit: string }
  | { kind: "unresolved" };

const FULL_SHA_LENGTH = 40;
const UNRESOLVED: CommitBase = { kind: "unresolved" };

// One `git log` of HEAD and at most one batched read of live objects for the whole set, keyed by
// the commit strings as the documents store them. `stored` is the corpus's identity store, which
// outlives the objects; a live object answers for a commit the store does not hold yet.
export async function resolveCommitBases(
  projectRoot: string,
  commits: string[],
  stored: ReadonlyMap<string, string>,
): Promise<Map<string, CommitBase>> {
  const distinct = [...new Set(commits)];
  if (distinct.length === 0) return new Map();
  const history = await readHeadHistory(projectRoot);
  if (history === undefined) return new Map(distinct.map((commit) => [commit, UNRESOLVED]));
  const headShas = new Set(history.map((record) => record.sha));
  const offHead = distinct.filter((commit) => expandCommit(commit, headShas) === undefined);
  const live = await readLiveCommitIdentities(projectRoot, offHead);
  const headShasByIdentity = groupShasByIdentity(history);
  return new Map(
    distinct.map((commit) => {
      if (expandCommit(commit, headShas) !== undefined) return [commit, { kind: "on-head", commit }];
      return [commit, offHeadBase(commit, live, stored, headShasByIdentity)];
    }),
  );
}

function offHeadBase(
  commit: string,
  live: ReadonlyMap<string, string>,
  stored: ReadonlyMap<string, string>,
  headShasByIdentity: ReadonlyMap<string, string[]>,
): CommitBase {
  const liveSha = expandCommit(commit, live);
  const identity = identityOf(commit, stored) ?? (liveSha === undefined ? undefined : live.get(liveSha));
  const copies = identity === undefined ? [] : (headShasByIdentity.get(identity) ?? []);
  if (copies.length === 1) return { kind: "copy", commit: copies[0]! };
  if (liveSha !== undefined) return { kind: "off-head", commit };
  return UNRESOLVED;
}

function identityOf(commit: string, stored: ReadonlyMap<string, string>): string | undefined {
  const storedSha = expandCommit(commit, stored);
  return storedSha === undefined ? undefined : stored.get(storedSha);
}

// A repository that cannot answer `git log HEAD` (not a repository, no commit yet) has no history
// to measure against.
async function readHeadHistory(projectRoot: string): Promise<CommitRecord[] | undefined> {
  const result = await runGit(projectRoot, ["log", ...COMMIT_RECORD_ARGS, "HEAD"]);
  if (result.exitCode !== 0) return undefined;
  return parseCommitRecords(result.stdout);
}

function groupShasByIdentity(history: CommitRecord[]): Map<string, string[]> {
  const shasByIdentity = new Map<string, string[]>();
  for (const record of history) {
    const shas = shasByIdentity.get(record.identity) ?? [];
    shas.push(record.sha);
    shasByIdentity.set(record.identity, shas);
  }
  return shasByIdentity;
}

// A full sha matches only itself; an abbreviated one (hand-written notes) matches by a unique
// prefix, and an ambiguous prefix matches nothing.
function expandCommit(commit: string, known: ReadonlySet<string> | ReadonlyMap<string, unknown>): string | undefined {
  if (commit.length === FULL_SHA_LENGTH) return known.has(commit) ? commit : undefined;
  const matches = [...known.keys()].filter((sha) => sha.startsWith(commit));
  return matches.length === 1 ? matches[0] : undefined;
}
