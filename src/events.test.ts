import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventWriter, readEvents } from "./events";
import { SCHEMA_VERSION } from "./event-schema";

function tempEventsDir(): string {
  return mkdtempSync(join(tmpdir(), "mneme-events-"));
}

const writerOptions = {
  sessionId: "session-abc",
  mnemeVersion: "0.1.0",
  clock: () => new Date("2026-03-15T12:00:00.000Z"),
};

describe("EventWriter and readEvents", () => {
  test("stamps and reads back the injected envelope", () => {
    const eventsDir = tempEventsDir();
    const writer = new EventWriter(eventsDir, writerOptions);

    writer.append({ type: "note_written", note_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });

    const events = readEvents(eventsDir);
    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.session_id).toBe("session-abc");
    expect(event.ts).toBe("2026-03-15T12:00:00.000Z");
    expect(event.mneme_version).toBe("0.1.0");
    expect(event.schema_version).toBe(SCHEMA_VERSION);
    expect(event.type).toBe("note_written");
    expect(event.note_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  test("the injected envelope overrides all four spoofed payload fields", () => {
    const eventsDir = tempEventsDir();
    const writer = new EventWriter(eventsDir, writerOptions);

    writer.append({
      type: "note_written",
      session_id: "spoofed-session",
      ts: "1999-01-01T00:00:00.000Z",
      mneme_version: "9.9.9",
      schema_version: 42,
    });

    const event = readEvents(eventsDir)[0]!;
    expect(event.session_id).toBe("session-abc");
    expect(event.ts).toBe("2026-03-15T12:00:00.000Z");
    expect(event.mneme_version).toBe("0.1.0");
    expect(event.schema_version).toBe(SCHEMA_VERSION);
  });
});

describe("EventWriter monthly rotation", () => {
  const savedTimeZone = process.env.TZ;
  afterEach(() => {
    if (savedTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedTimeZone;
  });

  test("rotation uses UTC month, not local month", () => {
    process.env.TZ = "America/New_York";
    const eventsDir = tempEventsDir();
    const writer = new EventWriter(eventsDir, {
      sessionId: "s",
      mnemeVersion: "0.1.0",
      clock: () => new Date("2026-02-01T02:00:00.000Z"),
    });

    writer.append({ type: "note_written" });

    expect(readdirSync(eventsDir)).toContain("2026-02.jsonl");
  });

  test("events are read in chronological file order across months", () => {
    const eventsDir = tempEventsDir();
    new EventWriter(eventsDir, {
      sessionId: "s",
      mnemeVersion: "0.1.0",
      clock: () => new Date("2026-02-15T12:00:00.000Z"),
    }).append({ type: "note_written", marker: "february" });
    new EventWriter(eventsDir, {
      sessionId: "s",
      mnemeVersion: "0.1.0",
      clock: () => new Date("2026-01-15T12:00:00.000Z"),
    }).append({ type: "note_written", marker: "january" });

    const events = readEvents(eventsDir);
    expect(events.map((event) => event.marker)).toEqual(["january", "february"]);
  });
});

describe("readEvents tolerance and forward compatibility", () => {
  test("skips a torn line in the middle of a file", () => {
    const eventsDir = tempEventsDir();
    const writer = new EventWriter(eventsDir, writerOptions);
    writer.append({ type: "note_written", marker: "first" });
    appendFileSync(join(eventsDir, "2026-03.jsonl"), "{ this line is torn garbage\n");
    writer.append({ type: "note_written", marker: "second" });

    const events = readEvents(eventsDir);
    expect(events.length).toBe(2);
    expect(events.map((event) => event.marker)).toEqual(["first", "second"]);
  });

  test("coerces a non-string type to empty string, preserving schema_version", () => {
    const eventsDir = tempEventsDir();
    appendFileSync(
      join(eventsDir, "2020-02.jsonl"),
      JSON.stringify({ type: 123, schema_version: 5 }) + "\n",
    );

    const event = readEvents(eventsDir)[0]!;
    expect(event.type).toBe("");
    expect(event.schema_version).toBe(5);
  });

  test("skips a valid-JSON primitive line between two valid events", () => {
    const eventsDir = tempEventsDir();
    const writer = new EventWriter(eventsDir, writerOptions);
    writer.append({ type: "note_written", marker: "before" });
    appendFileSync(join(eventsDir, "2026-03.jsonl"), "42\n");
    writer.append({ type: "note_written", marker: "after" });

    const events = readEvents(eventsDir);
    expect(events.length).toBe(2);
    expect(events.map((event) => event.marker)).toEqual(["before", "after"]);
  });

  test("normalizes a pre-stamp line to schema_version 0 with null envelope", () => {
    const eventsDir = tempEventsDir();
    appendFileSync(
      join(eventsDir, "2020-01.jsonl"),
      JSON.stringify({ type: "legacy_event", payload: 123 }) + "\n",
    );

    const event = readEvents(eventsDir)[0]!;
    expect(event.schema_version).toBe(0);
    expect(event.mneme_version).toBeNull();
    expect(event.session_id).toBeNull();
    expect(event.ts).toBeNull();
    expect(event.type).toBe("legacy_event");
  });

  test("reads pre-stamp schema-v1 legacy write-path lines as schema_version 0 without throwing", () => {
    const eventsDir = tempEventsDir();
    const legacyLines = [
      { type: "note_staged", note_id: "n1", note_type: "pattern" },
      { type: "note_accepted", note_id: "n1", commit: "abc1234" },
      { type: "note_deduped", note_id: "n2", existing_id: "n1", similarity: 0.99 },
    ];
    for (const line of legacyLines) {
      appendFileSync(join(eventsDir, "2020-03.jsonl"), JSON.stringify(line) + "\n");
    }

    const events = readEvents(eventsDir);

    expect(events.map((event) => event.type)).toEqual(["note_staged", "note_accepted", "note_deduped"]);
    for (const event of events) {
      expect(event.schema_version).toBe(0);
      expect(event.session_id).toBeNull();
      expect(event.ts).toBeNull();
      expect(event.mneme_version).toBeNull();
    }
  });
});

describe("readEvents file selection", () => {
  test("ignores non-.jsonl files alongside a real event log", () => {
    const eventsDir = tempEventsDir();
    const writer = new EventWriter(eventsDir, writerOptions);
    writer.append({ type: "note_written", marker: "real" });
    writeFileSync(join(eventsDir, "foo.txt"), "not an event line\n");
    writeFileSync(join(eventsDir, "index.db"), "binary sidecar\n");

    const events = readEvents(eventsDir);
    expect(events.length).toBe(1);
    expect(events[0]!.marker).toBe("real");
  });

  test("returns an empty array for an empty events directory", () => {
    const eventsDir = tempEventsDir();
    expect(readEvents(eventsDir)).toEqual([]);
  });
});
