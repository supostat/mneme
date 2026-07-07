import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENT_FILE_EXTENSION } from "./events";
import type { StoredEvent } from "./events";

// The on-disk cost of the event log: total bytes across the monthly files plus how many events each
// type contributes. Both are computed from the same directory the stats tool already reads, so the
// footprint answers "how big is the log, and what fills it" without a second pass over note bodies.

export interface FootprintSummary {
  totalBytes: number;
  fileBytes: Array<{ name: string; bytes: number }>;
  eventsPerType: Record<string, number>;
}

export function computeFootprint(eventsDir: string, events: StoredEvent[]): FootprintSummary {
  const files = readdirSync(eventsDir)
    .filter((name) => name.endsWith(EVENT_FILE_EXTENSION))
    .sort();
  const fileBytes = files.map((name) => ({ name, bytes: statSync(join(eventsDir, name)).size }));
  const totalBytes = fileBytes.reduce((sum, file) => sum + file.bytes, 0);
  return { totalBytes, fileBytes, eventsPerType: eventsPerType(events) };
}

function eventsPerType(events: StoredEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

export function formatFootprint(summary: FootprintSummary): string {
  return [
    "Log footprint (from the event log)",
    "",
    `(g) Total size: ${summary.totalBytes} bytes across ${summary.fileBytes.length} files`,
    "Bytes per file:",
    ...renderFileBytes(summary.fileBytes),
    "Events per type:",
    ...renderEventsPerType(summary.eventsPerType),
  ].join("\n");
}

function renderFileBytes(fileBytes: FootprintSummary["fileBytes"]): string[] {
  if (fileBytes.length === 0) return ["  (no files)"];
  return fileBytes.map((file) => `  ${file.name}: ${file.bytes} bytes`);
}

function renderEventsPerType(eventsPerType: Record<string, number>): string[] {
  const types = Object.keys(eventsPerType).sort();
  if (types.length === 0) return ["  (no events)"];
  return types.map((type) => `  ${type === "" ? "(untyped)" : type}: ${eventsPerType[type]}`);
}
