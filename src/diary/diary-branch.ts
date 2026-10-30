import type { StoredEvent } from "../events";
import { resolveCurrentBranch } from "../workflow/run-branch";
import type { BranchTerminal } from "./diary-rendering";
import { lastTerminalRunOf } from "./diary-run-facts";

// The current branch's newest finished run, for the session form and the brief line alike. Off a
// branch there is nothing branch-scoped to look up, and the answer says which way git failed rather
// than throwing — an error would be logged, and the diary path writes nothing.
export async function branchTerminalOf(projectRoot: string, events: StoredEvent[]): Promise<BranchTerminal> {
  const resolution = await resolveCurrentBranch(projectRoot);
  if (resolution.kind !== "branch") return { kind: resolution.kind };
  return { kind: "branch", branch: resolution.name, lastTerminal: lastTerminalRunOf(events, resolution.name) };
}
