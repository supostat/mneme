import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTracked } from "./staleness";

export type AnchorLiveness = "tracked" | "untracked-exists" | "missing";

export interface StagedAnchor {
  path: string;
  liveness: AnchorLiveness;
}

export function resolveAnchorLiveness(projectRoot: string, anchors: string[]): Promise<StagedAnchor[]> {
  return Promise.all(anchors.map(async (path) => ({ path, liveness: await livenessOf(projectRoot, path) })));
}

async function livenessOf(projectRoot: string, anchor: string): Promise<AnchorLiveness> {
  if (await isTracked(projectRoot, anchor)) {
    return "tracked";
  }
  return existsSync(join(projectRoot, anchor)) ? "untracked-exists" : "missing";
}
