import type { StoredEvent } from "../events";

// A diary entry is an ordinary note that went through staging like any other — what makes it the
// entry for a run is two tags: DIARY_TAG names its kind, runTag(runId) names the run it reflects on.
// The engine never looks at the note's type. The event log answers "does run R have an entry" on
// its own: the v22 remember event carries the tags verbatim.

export const DIARY_TAG = "diary";
export const RUN_TAG_PREFIX = "run:";

export function runTag(runId: string): string {
  return `${RUN_TAG_PREFIX}${runId}`;
}

// The runs with a diary entry: a remember carrying DIARY_TAG and a run tag that actually staged a
// note (a dedup noop staged nothing) whose note the human did not reject. An entry still awaiting
// review counts — otherwise a hook would keep asking for an entry that already sits in the queue —
// and so does an accepted or a superseding one. A remember from before v22 has no tags and is no
// entry.
export function runIdsWithDiaryEntry(events: StoredEvent[]): Set<string> {
  const rejected = rejectedNoteIds(events);
  const runIds = new Set<string>();
  for (const event of events) {
    const noteId = stagedNoteIdOf(event);
    if (noteId === null || rejected.has(noteId)) continue;
    const tags = tagsOf(event);
    if (!tags.includes(DIARY_TAG)) continue;
    for (const tag of tags) {
      if (tag.startsWith(RUN_TAG_PREFIX)) runIds.add(tag.slice(RUN_TAG_PREFIX.length));
    }
  }
  return runIds;
}

// The note a remember event put into the queue, or null for any other event: every dedup outcome
// but "noop" stages one.
export function stagedNoteIdOf(event: StoredEvent): string | null {
  if (event.type !== "remember" || typeof event.note_id !== "string") return null;
  const dedup = event.dedup;
  const staged = typeof dedup === "object" && dedup !== null && (dedup as Record<string, unknown>).outcome !== "noop";
  return staged ? event.note_id : null;
}

function tagsOf(event: StoredEvent): string[] {
  return Array.isArray(event.tags) ? event.tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function rejectedNoteIds(events: StoredEvent[]): Set<string> {
  const rejected = new Set<string>();
  for (const event of events) {
    if (event.type === "staging_resolve" && event.decision === "reject" && typeof event.note_id === "string") {
      rejected.add(event.note_id);
    }
  }
  return rejected;
}
