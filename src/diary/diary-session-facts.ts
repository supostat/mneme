import type { RecallOrigin } from "../event-schema";
import type { StoredEvent } from "../events";
import { REMEMBER_TOOL_SOURCE } from "../staging";
import { stagedNoteIdOf } from "./diary-entries";

// What one server session asked memory and wrote back, read off the event log in log order. A memory
// gap is a manual recall the engine answered with nothing above the threshold; it stays OPEN until
// the session's next hand-written note, because the gap notice told the agent to record what it
// learns. The engine's own phase recalls belong to runs, not to the session's questions.

export interface MemoryGap {
  ts: string | null;
  query: string;
  open: boolean;
}

export interface SessionFacts {
  sessionId: string;
  recalls: number;
  notes: number;
  gaps: MemoryGap[];
}

const RECALL_TOOL_ORIGIN: RecallOrigin = "tool-call";

export function sessionFacts(events: StoredEvent[], sessionId: string): SessionFacts {
  let recalls = 0;
  let notes = 0;
  const gaps: Array<{ ts: string | null; query: string; position: number }> = [];
  let lastNotePosition = -1;
  events.forEach((event, position) => {
    if (event.session_id !== sessionId) return;
    const query = manualRecallQueryOf(event);
    if (query !== null) {
      recalls += 1;
      if (event.gap === true) gaps.push({ ts: event.ts, query, position });
    } else if (isManualNote(event)) {
      notes += 1;
      lastNotePosition = position;
    }
  });
  return {
    sessionId,
    recalls,
    notes,
    gaps: gaps.map((gap) => ({ ts: gap.ts, query: gap.query, open: gap.position > lastNotePosition })),
  };
}

export type ProcessAliveCheck = (pid: number) => boolean;

// The sessions still running, oldest first: a session_start that names a pid, no session_end for the
// same session, and a process behind the pid. A session cut off without its session_end (SIGKILL, a
// killed terminal) is told apart by its dead pid; a session_start from before v22 names no pid and is
// never live. A pid recycled by an unrelated process reads as a second live session — the caller
// degrades on that, which errs on the safe side.
export function liveSessionIds(events: StoredEvent[], isProcessAlive: ProcessAliveCheck): string[] {
  const ended = new Set(
    events.flatMap((event) => (event.type === "session_end" && event.session_id !== null ? [event.session_id] : [])),
  );
  return events.flatMap((event) => {
    if (event.type !== "session_start" || event.session_id === null || ended.has(event.session_id)) return [];
    const pid = event.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return [];
    return isProcessAlive(pid) ? [event.session_id] : [];
  });
}

// Signal 0 probes a process without touching it: EPERM means it exists under another user, ESRCH
// that it is gone. Any other failure is not an answer about liveness and is raised.
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

// The query of a recall the agent issued through the tool, or null for any other event.
function manualRecallQueryOf(event: StoredEvent): string | null {
  if (event.type !== "recall" || event.origin !== RECALL_TOOL_ORIGIN) return null;
  return typeof event.query === "string" ? event.query : null;
}

function isManualNote(event: StoredEvent): boolean {
  return stagedNoteIdOf(event) !== null && event.source === REMEMBER_TOOL_SOURCE;
}
