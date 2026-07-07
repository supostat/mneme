import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./event-schema";

export const EVENT_FILE_EXTENSION = ".jsonl";
const PRE_STAMP_SCHEMA_VERSION = 0;

export type EventInput = { type: string } & Record<string, unknown>;

export type StoredEvent = {
  type: string;
  session_id: string | null;
  ts: string | null;
  mneme_version: string | null;
  schema_version: number;
} & Record<string, unknown>;

export interface EventWriterOptions {
  sessionId: string;
  clock: () => Date;
  mnemeVersion: string;
}

export class EventWriter {
  constructor(
    private readonly eventsDir: string,
    private readonly options: EventWriterOptions,
  ) {}

  append(event: EventInput): void {
    const now = this.options.clock();
    const stamped: StoredEvent = {
      ...event,
      session_id: this.options.sessionId,
      ts: now.toISOString(),
      mneme_version: this.options.mnemeVersion,
      schema_version: SCHEMA_VERSION,
    };
    appendFileSync(
      join(this.eventsDir, monthlyFileName(now)),
      JSON.stringify(stamped) + "\n",
    );
  }
}

function monthlyFileName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}${EVENT_FILE_EXTENSION}`;
}

export function readEvents(eventsDir: string): StoredEvent[] {
  const files = readdirSync(eventsDir)
    .filter((name) => name.endsWith(EVENT_FILE_EXTENSION))
    .sort();
  const events: StoredEvent[] = [];
  for (const file of files) {
    const content = readFileSync(join(eventsDir, file), "utf8");
    for (const line of content.split("\n")) {
      if (line === "") continue;
      const parsed = tryParseLine(line);
      if (parsed !== undefined) events.push(normalizeEvent(parsed));
    }
  }
  return events;
}

function tryParseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeEvent(raw: Record<string, unknown>): StoredEvent {
  return {
    ...raw,
    type: typeof raw.type === "string" ? raw.type : "",
    session_id: typeof raw.session_id === "string" ? raw.session_id : null,
    ts: typeof raw.ts === "string" ? raw.ts : null,
    mneme_version: typeof raw.mneme_version === "string" ? raw.mneme_version : null,
    schema_version:
      typeof raw.schema_version === "number"
        ? raw.schema_version
        : PRE_STAMP_SCHEMA_VERSION,
  };
}
