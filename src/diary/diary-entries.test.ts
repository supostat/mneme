import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { EventWriter, readEvents } from "../events";
import type { EventInput, StoredEvent } from "../events";
import { dedupPayload } from "../staging-resolve";
import { DIARY_TAG, RUN_TAG_PREFIX, runIdsWithDiaryEntry, runTag, stagedNoteIdOf } from "./diary-entries";

// "Run R has a diary entry" is decided off the log alone: the tags on the remember event, the dedup
// outcome that says whether a note was staged at all, and the human's decision on that note.

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const OTHER_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";

function logOf(...events: EventInput[]): StoredEvent[] {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-diary-entries-"));
  const writer = new EventWriter(eventsDir, {
    sessionId: "s-diary",
    mnemeVersion: "0.1.0",
    clock: () => new Date("2026-10-30T10:00:00.000Z"),
  });
  for (const event of events) writer.append(event);
  return readEvents(eventsDir);
}

function remembered(noteId: string, tags: string[], outcome: "add" | "noop" = "add"): EventInput {
  return {
    type: "remember",
    note_id: noteId,
    note_type: "decision",
    body_len: 12,
    anchors_n: 0,
    tags_n: tags.length,
    tags,
    source: "mcp",
    dedup: dedupPayload(outcome, null, null, false, defaultConfig().dedup),
  };
}

function resolved(noteId: string, decision: "accept" | "reject" | "supersede"): EventInput {
  return {
    type: "staging_resolve",
    note_id: noteId,
    decision,
    staged_to_resolved_ms: 0,
    commit: decision === "reject" ? null : "abc1234",
    superseded_id: decision === "supersede" ? "n0" : null,
    suggested: null,
    accepted_body_len: null,
    accepted_anchors_n: null,
    menu: null,
  };
}

describe("the diary tag format", () => {
  test("a run's tag is the run prefix followed by the run id", () => {
    expect(runTag(RUN_ID)).toBe(`${RUN_TAG_PREFIX}${RUN_ID}`);
    expect(runTag(RUN_ID)).toBe("run:01ARZ3NDEKTSV4RRFFQ69G5FA0");
    expect(DIARY_TAG).toBe("diary");
  });
});

describe("runIdsWithDiaryEntry", () => {
  test("an entry still awaiting review counts", () => {
    const events = logOf(remembered("n1", [DIARY_TAG, runTag(RUN_ID)]));

    expect([...runIdsWithDiaryEntry(events)]).toEqual([RUN_ID]);
  });

  test("an accepted entry and a superseding entry both count", () => {
    const events = logOf(
      remembered("n1", [DIARY_TAG, runTag(RUN_ID)]),
      resolved("n1", "accept"),
      remembered("n2", [DIARY_TAG, runTag(OTHER_RUN_ID)]),
      resolved("n2", "supersede"),
    );

    expect(runIdsWithDiaryEntry(events)).toEqual(new Set([RUN_ID, OTHER_RUN_ID]));
  });

  test("a rejected entry is no entry", () => {
    const events = logOf(remembered("n1", [DIARY_TAG, runTag(RUN_ID)]), resolved("n1", "reject"));

    expect(runIdsWithDiaryEntry(events).size).toBe(0);
  });

  test("a dedup noop staged nothing and is no entry", () => {
    const events = logOf(remembered("n1", [DIARY_TAG, runTag(RUN_ID)], "noop"));

    expect(runIdsWithDiaryEntry(events).size).toBe(0);
  });

  test("both tags are required: a run tag without the diary tag, or the diary tag alone, names no run", () => {
    const events = logOf(remembered("n1", [runTag(RUN_ID)]), remembered("n2", [DIARY_TAG, "retro"]));

    expect(runIdsWithDiaryEntry(events).size).toBe(0);
  });

  // Tolerance fixture: a remember stamped before v22 carries tags_n but no tags key.
  test("a pre-v22 remember without a tags key is no entry and does not throw", () => {
    const { tags: _omitted, ...withoutTags } = remembered("n1", [DIARY_TAG, runTag(RUN_ID)]);
    const events = logOf({ ...withoutTags, tags_n: 2 });

    expect(runIdsWithDiaryEntry(events).size).toBe(0);
  });
});

describe("stagedNoteIdOf", () => {
  test("names the note a remember staged, and nothing for a noop or any other event", () => {
    const [staged, noop, decision] = logOf(
      remembered("n1", []),
      remembered("n2", [], "noop"),
      resolved("n1", "accept"),
    );

    expect(stagedNoteIdOf(staged!)).toBe("n1");
    expect(stagedNoteIdOf(noop!)).toBeNull();
    expect(stagedNoteIdOf(decision!)).toBeNull();
  });
});
