import { homedir } from "node:os";
import { rebuild } from "./index-db";
import type { RebuildDeps } from "./index-db";
import { sanitizeToolErrorMessage } from "./sanitize";

// What a committed staging decision reports about the index. The rebuild runs AFTER the note moved,
// the corpus committed and the decision's event was written, so its failure must not turn that
// decision into a tool error: the decision stands, the reason is logged as rebuild_failed, and the
// next successful rebuild (it reads notes/ whole) catches the index up.
export type IndexRefresh = { rebuilt: true } | { rebuilt: false; reason: string };

export async function refreshIndexAfterDecision(deps: RebuildDeps, corpusDir: string): Promise<IndexRefresh> {
  try {
    await rebuild(deps);
    return { rebuilt: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = sanitizeToolErrorMessage(message, { homeDir: homedir(), corpusDir });
    deps.eventWriter.append({ type: "rebuild_failed", message: reason });
    return { rebuilt: false, reason };
  }
}
