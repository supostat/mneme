import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git";

export type AnchorLiveness = "tracked" | "untracked-exists" | "missing";

export interface StagedAnchor {
  path: string;
  liveness: AnchorLiveness;
}

export function resolveAnchorLiveness(projectRoot: string, anchors: string[]): Promise<StagedAnchor[]> {
  return Promise.all(anchors.map(async (path) => ({ path, liveness: await livenessOf(projectRoot, path) })));
}

async function livenessOf(projectRoot: string, anchor: string): Promise<AnchorLiveness> {
  const tracked = await runGit(projectRoot, ["ls-files", "--error-unmatch"], [anchor]);
  if (tracked.exitCode === 0) {
    return "tracked";
  }
  return existsSync(join(projectRoot, anchor)) ? "untracked-exists" : "missing";
}
