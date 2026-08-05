import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git";

// The single home of anchor liveness: the trackedness probe, the branch-tips path map, and the
// four-state classification every consumer (staleness ranking, staging warnings, the sweep) reads
// through. One predicate, one map — the warning and the sink can never disagree.

export type AnchorLiveness = "tracked" | "untracked-exists" | "known-elsewhere" | "missing";

export interface StagedAnchor {
  path: string;
  liveness: AnchorLiveness;
  branches?: string[];
  // Set only for missing anchors that were probed against history: false marks a path git has
  // never seen — likely a concept string, not a file.
  everExisted?: boolean;
}

// One trackedness probe for the whole engine: git ls-files in the CURRENT worktree. Re-exported
// through staleness.ts so historical importers keep their path.
export async function isTracked(projectRoot: string, anchor: string): Promise<boolean> {
  const result = await runGit(projectRoot, ["ls-files", "--error-unmatch"], [anchor]);
  return result.exitCode === 0;
}

export interface LivenessContext {
  projectRoot: string;
  branchPaths: Map<string, string[]>;
  // The local branches the map was built from — the honest denominator a report cites: a fresh
  // clone with fewer branches legitimately sees a different liveness picture.
  branches: string[];
}

// The branch-tips path map: one for-each-ref plus one ls-tree PER BRANCH — O(branches) git calls
// for a whole pass, never per anchor. Build it ONCE per operation and thread it as context; the
// map is a snapshot of branch TIPS now, it renders no verdicts from history.
export async function createLivenessContext(projectRoot: string): Promise<LivenessContext> {
  const branchPaths = new Map<string, string[]>();
  const refs = await runGit(projectRoot, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]);
  const branches = refs.exitCode === 0 ? branchNames(refs.stdout) : [];
  for (const branch of branches) {
    const tree = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", branch]);
    if (tree.exitCode !== 0) continue;
    for (const path of tree.stdout.split("\n")) {
      if (path === "") continue;
      const carrying = branchPaths.get(path) ?? [];
      carrying.push(branch);
      branchPaths.set(path, carrying);
    }
  }
  return { projectRoot, branchPaths, branches };
}

// Has git EVER seen this path in any reachable ref's history? A "no" separates a concept-anchor
// (MultiSelect, soft-delete — never a file) from an honestly deleted file whose history remains.
// Called only for the small no-successor/missing sets, never per anchor in bulk.
export async function pathEverExisted(projectRoot: string, anchor: string): Promise<boolean> {
  const result = await runGit(projectRoot, ["log", "--all", "-1", "--format=%H"], [anchor]);
  return result.exitCode === 0 && result.stdout.trim() !== "";
}

function branchNames(refsOutput: string): string[] {
  return refsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function resolveAnchorLiveness(context: LivenessContext, anchors: string[]): Promise<StagedAnchor[]> {
  return Promise.all(anchors.map((path) => livenessOf(context, path)));
}

// The order is semantic: a file on disk this session is HERE (untracked-exists), never "elsewhere";
// only a path absent from both the index and the disk asks the branch map.
export async function livenessOf(context: LivenessContext, anchor: string): Promise<StagedAnchor> {
  if (await isTracked(context.projectRoot, anchor)) {
    return { path: anchor, liveness: "tracked" };
  }
  if (existsSync(join(context.projectRoot, anchor))) {
    return { path: anchor, liveness: "untracked-exists" };
  }
  const branches = context.branchPaths.get(anchor);
  if (branches !== undefined) {
    return { path: anchor, liveness: "known-elsewhere", branches };
  }
  return { path: anchor, liveness: "missing" };
}
