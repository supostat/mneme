import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "./events";
import type { StoredEvent } from "./events";
import { computeFootprint, formatFootprint } from "./stats-footprint";

function tempEventsDir(): string {
  return mkdtempSync(join(tmpdir(), "mneme-footprint-"));
}

// A body with multi-byte characters, so the byte count and the character count differ.
const JANUARY =
  JSON.stringify({ type: "remember", note_id: "n1", schema_version: 3, session_id: "s", ts: "2026-01-15T10:00:00.000Z", mneme_version: "0.1.0" }) +
  "\n" +
  JSON.stringify({ type: "recall", schema_version: 3, session_id: "s", ts: "2026-01-15T11:00:00.000Z", mneme_version: "0.1.0", query: "café ☕" }) +
  "\n";
const FEBRUARY =
  JSON.stringify({ type: "recall", schema_version: 3, session_id: "s", ts: "2026-02-01T10:00:00.000Z", mneme_version: "0.1.0" }) +
  "\n";

describe("computeFootprint", () => {
  test("totals the exact byte length of each monthly file", () => {
    const eventsDir = tempEventsDir();
    // Written out of lexical order so the expected [2026-01, 2026-02] fileBytes ordering depends on
    // computeFootprint's files.sort() rather than on the directory listing order.
    writeFileSync(join(eventsDir, "2026-02.jsonl"), FEBRUARY);
    writeFileSync(join(eventsDir, "2026-01.jsonl"), JANUARY);

    const summary = computeFootprint(eventsDir, readEvents(eventsDir));

    expect(summary.fileBytes).toEqual([
      { name: "2026-01.jsonl", bytes: Buffer.byteLength(JANUARY) },
      { name: "2026-02.jsonl", bytes: Buffer.byteLength(FEBRUARY) },
    ]);
    expect(summary.totalBytes).toBe(Buffer.byteLength(JANUARY) + Buffer.byteLength(FEBRUARY));
  });

  test("counts events per type from the parsed log", () => {
    const eventsDir = tempEventsDir();
    writeFileSync(join(eventsDir, "2026-01.jsonl"), JANUARY);
    writeFileSync(join(eventsDir, "2026-02.jsonl"), FEBRUARY);

    const summary = computeFootprint(eventsDir, readEvents(eventsDir));

    expect(summary.eventsPerType).toEqual({ remember: 1, recall: 2 });
  });

  test("ignores non-.jsonl sidecar files", () => {
    const eventsDir = tempEventsDir();
    writeFileSync(join(eventsDir, "2026-01.jsonl"), JANUARY);
    writeFileSync(join(eventsDir, "index.db"), "binary sidecar\n");
    writeFileSync(join(eventsDir, "notes.txt"), "not an event line\n");

    const summary = computeFootprint(eventsDir, readEvents(eventsDir));

    expect(summary.fileBytes).toEqual([{ name: "2026-01.jsonl", bytes: Buffer.byteLength(JANUARY) }]);
    expect(summary.totalBytes).toBe(Buffer.byteLength(JANUARY));
  });
});

describe("formatFootprint", () => {
  test("renders per-file bytes alongside the total", () => {
    const eventsDir = tempEventsDir();
    writeFileSync(join(eventsDir, "2026-01.jsonl"), JANUARY);
    writeFileSync(join(eventsDir, "2026-02.jsonl"), FEBRUARY);

    const rendered = formatFootprint(computeFootprint(eventsDir, readEvents(eventsDir)));

    expect(rendered).toContain(
      `(g) Total size: ${Buffer.byteLength(JANUARY) + Buffer.byteLength(FEBRUARY)} bytes across 2 files`,
    );
    expect(rendered).toContain(`  2026-01.jsonl: ${Buffer.byteLength(JANUARY)} bytes`);
    expect(rendered).toContain(`  2026-02.jsonl: ${Buffer.byteLength(FEBRUARY)} bytes`);
  });

  test("renders the empty type as (untyped)", () => {
    const untyped: StoredEvent = {
      type: "",
      session_id: null,
      ts: null,
      mneme_version: "0.1.0",
      schema_version: 0,
    };

    const rendered = formatFootprint(computeFootprint(tempEventsDir(), [untyped]));

    expect(rendered).toContain("(untyped): 1");
  });
});
