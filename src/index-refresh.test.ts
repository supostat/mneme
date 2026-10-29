import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_MODEL } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";
import type { RebuildDeps } from "./index-db";
import { refreshIndexAfterDecision } from "./index-refresh";
import { isIndexMarkedStale } from "./index-stale-marker";

const fixedClock = () => new Date("2026-10-29T10:00:00.000Z");

const silentClient: EmbeddingsClient = {
  model: EMBEDDING_MODEL,
  embed: async () => ({ available: true, embeddings: [], retries: 0 }),
};

function corpusLayout(): { corpusDir: string; eventsDir: string; deps: (notesDir: string) => RebuildDeps } {
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-refresh-"));
  const eventsDir = join(corpusDir, "events");
  mkdirSync(eventsDir);
  const eventWriter = new EventWriter(eventsDir, { sessionId: "s-refresh", mnemeVersion: "0.1.0", clock: fixedClock });
  return {
    corpusDir,
    eventsDir,
    deps: (notesDir) => ({
      indexPath: join(corpusDir, "index.db"),
      notesDir,
      mapDir: join(corpusDir, "map"),
      projectRoot: corpusDir,
      embeddings: silentClient,
      eventWriter,
      clock: fixedClock,
    }),
  };
}

describe("refreshIndexAfterDecision", () => {
  test("a rebuild that goes through reports the index rebuilt and logs no rebuild_failed", async () => {
    const layout = corpusLayout();
    const notesDir = join(layout.corpusDir, "notes");
    mkdirSync(notesDir);

    const refresh = await refreshIndexAfterDecision(layout.deps(notesDir), layout.corpusDir);

    expect(refresh).toEqual({ rebuilt: true });
    expect(readEvents(layout.eventsDir).map((event) => event.type)).toEqual(["rebuild"]);
    expect(isIndexMarkedStale(join(layout.corpusDir, "index.db"))).toBe(false);
  });

  test("a rebuild that throws marks the index stale, so the next read rebuilds before it reads", async () => {
    const layout = corpusLayout();
    const missingNotesDir = join(layout.corpusDir, "notes");

    await refreshIndexAfterDecision(layout.deps(missingNotesDir), layout.corpusDir);

    expect(isIndexMarkedStale(join(layout.corpusDir, "index.db"))).toBe(true);
  });

  test("a rebuild that throws becomes a sanitized reason, logged once as rebuild_failed", async () => {
    const layout = corpusLayout();
    const missingNotesDir = join(layout.corpusDir, "notes");

    const refresh = await refreshIndexAfterDecision(layout.deps(missingNotesDir), layout.corpusDir);

    expect(refresh).toEqual({
      rebuilt: false,
      reason: "ENOENT: no such file or directory, scandir '<corpus>/notes'",
    });
    const events = readEvents(layout.eventsDir);
    expect(events.map((event) => event.type)).toEqual(["rebuild_failed"]);
    expect(events[0]!.message).toBe("ENOENT: no such file or directory, scandir '<corpus>/notes'");
  });
});
