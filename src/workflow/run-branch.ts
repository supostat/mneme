import { runGit } from "../git";

// Fail-safe branch questions for the workflow surface: a non-zero git exit is always an explicit
// negative answer, never a thrown error. The caller decides what each negative means — notably
// branchExists distinguishes a PROVEN-missing branch (exit 1) from an unanswerable question
// (indeterminate), because only a proven-missing branch may mark a run stale. A current branch whose
// name carries U+0085/U+2028/U+2029 (legal in git refnames, forbidden in MCP response envelopes per
// run-directives.ts) is not anchorable and resolves as git-error: start refuses it, sync stays
// informational.

export type BranchResolution =
  | { kind: "branch"; name: string }
  | { kind: "detached" }
  | { kind: "git-error" };

export type BranchExistence = "exists" | "missing" | "indeterminate";

type CodePointRange = readonly [number, number];

const NEXT_LINE: CodePointRange = [0x0085, 0x0085];
const LINE_AND_PARAGRAPH_SEPARATORS: CodePointRange = [0x2028, 0x2029];

const FORBIDDEN_SEPARATOR_REGEX = forbiddenSeparatorRegex([NEXT_LINE, LINE_AND_PARAGRAPH_SEPARATORS]);

function forbiddenSeparatorRegex(ranges: readonly CodePointRange[]): RegExp {
  const characterClass = ranges
    .map(([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`)
    .join("");
  return new RegExp(`[${characterClass}]`, "u");
}

export function isAnchorableBranchName(name: string): boolean {
  return !FORBIDDEN_SEPARATOR_REGEX.test(name);
}

export async function resolveCurrentBranch(projectRoot: string): Promise<BranchResolution> {
  const result = await runGit(projectRoot, ["branch", "--show-current"]);
  if (result.exitCode !== 0) {
    return { kind: "git-error" };
  }
  const name = result.stdout.trim();
  if (name === "") {
    return { kind: "detached" };
  }
  if (!isAnchorableBranchName(name)) {
    return { kind: "git-error" };
  }
  return { kind: "branch", name };
}

export async function branchExists(projectRoot: string, name: string): Promise<BranchExistence> {
  const result = await runGit(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  if (result.exitCode === 0) {
    return "exists";
  }
  if (result.exitCode === 1) {
    return "missing";
  }
  return "indeterminate";
}
