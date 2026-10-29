import { homedir } from "node:os";
import { rebuild } from "./index-db";
import type { RebuildDeps } from "./index-db";
import { markIndexStale } from "./index-stale-marker";
import { sanitizeToolErrorMessage } from "./sanitize";

// What a committed staging decision reports about the index. The rebuild runs AFTER the note moved,
// the corpus committed and the decision's event was written, so its failure must not turn that
// decision into a tool error: the decision stands, the index is marked stale, the reason is logged
// as rebuild_failed, and the first read through indexNeedsRebuild (recall, a phase bundle) rebuilds
// from notes/ and map/ whole before it reads — as does any later committed decision.
export type IndexRefresh = { rebuilt: true } | { rebuilt: false; reason: string };

export async function refreshIndexAfterDecision(deps: RebuildDeps, corpusDir: string): Promise<IndexRefresh> {
  try {
    await rebuild(deps);
    return { rebuilt: true };
  } catch (error) {
    markIndexStale(deps.indexPath);
    const message = error instanceof Error ? error.message : String(error);
    const reason = sanitizeToolErrorMessage(message, { homeDir: homedir(), corpusDir });
    deps.eventWriter.append({ type: "rebuild_failed", message: reason });
    return { rebuilt: false, reason };
  }
}
