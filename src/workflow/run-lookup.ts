import type { StoredEvent } from "../events";
import { isNoteId } from "../note";
import { singleLine } from "../single-line";
import { restoreRuns } from "./run-events";
import type { ReadableRun } from "./run-events";

// The front door of every read-only tool that answers about one run by its id (diary_facts,
// workflow_spec): the id grammar, the unknown run and the unreadable run, each answered with the same
// plain text everywhere. A non-answer is text, never a throw — the server's dispatch logs a
// tool_error on a throw, and these tools must leave the log exactly as they found it.

export const NOT_WRITTEN = "Nothing was written.";
export const RUN_ID_INVALID_TEXT = `run_id is not a ULID or UUID. ${NOT_WRITTEN}`;

export type RunLookup =
  | { kind: "found"; run: ReadableRun }
  | { kind: "invalid-id" }
  | { kind: "unknown"; runId: string }
  | { kind: "unreadable"; runId: string; problem: string };

export type RunLookupMiss = Exclude<RunLookup, { kind: "found" }>;

export function lookUpRun(events: StoredEvent[], runId: string): RunLookup {
  if (!isNoteId(runId)) return { kind: "invalid-id" };
  const restored = restoreRuns(events).find((run) => run.runId === runId);
  if (restored === undefined) return { kind: "unknown", runId };
  if (restored.kind === "unreadable") return { kind: "unreadable", runId, problem: restored.problem };
  return { kind: "found", run: restored };
}

export function renderRunLookupMiss(miss: RunLookupMiss): string {
  if (miss.kind === "invalid-id") return RUN_ID_INVALID_TEXT;
  if (miss.kind === "unknown") return `No workflow run ${miss.runId} in this corpus. ${NOT_WRITTEN}`;
  return `Run ${miss.runId} cannot be read from the log: ${singleLine(miss.problem)}. ${NOT_WRITTEN}`;
}
