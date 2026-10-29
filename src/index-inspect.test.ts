import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapLayoutOf } from "./corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter } from "./events";
import { initRepo, runGit } from "./git";
import { rebuild } from "./index-db";
import { inspectIndex } from "./index-inspect";
import { writeMapSection } from "./map/map-store";
import type { MapSection } from "./map/map-section";
import { serializeNote } from "./note";
import type { Note } from "./note";
import { DEAD_ANCHOR_SINK } from "./staleness";

// The inspection is the doctor's only view of the index, so it is pinned against REAL rebuilds:
// a corpus with one note and two sections, one of them anchored to a path git never saw.

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");
const NOTE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index++) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const dimension = (hash >>> 0) % EMBEDDING_DIMENSION;
    vector[dimension] = vector[dimension]! + 1;
  }
  return vector;
}

const bagClient: EmbeddingsClient = {
  model: EMBEDDING_MODEL,
  embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }),
};

interface Layout {
  indexPath: string;
  notesDir: string;
  mapDir: string;
}

function corpusLayout(): Layout {
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-inspect-"));
  const mapDir = join(corpusDir, "map");
  mkdirSync(join(corpusDir, "notes"));
  mkdirSync(join(mapDir, "domains"), { recursive: true });
  mkdirSync(join(mapDir, "flows"));
  return { indexPath: join(corpusDir, "index.db"), notesDir: join(corpusDir, "notes"), mapDir };
}

async function projectWithFile(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-inspect-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"));
  writeFileSync(join(projectRoot, "src/a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return { projectRoot, commit: (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim() };
}

function section(id: string, anchors: string[], commit: string): MapSection {
  return {
    frontmatter: { id, kind: "domain", anchors, depends_on: [], terms: [], commit },
    body: `${id} section essence`,
  };
}

async function rebuildLayout(layout: Layout, projectRoot: string): Promise<void> {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-inspect-events-"));
  const eventWriter = new EventWriter(eventsDir, { sessionId: "s-inspect", mnemeVersion: "0.1.0", clock: fixedClock });
  await rebuild({ ...layout, projectRoot, embeddings: bagClient, eventWriter, clock: fixedClock });
}

describe("inspectIndex", () => {
  test("a missing index is absent with every count at zero", () => {
    const layout = corpusLayout();

    expect(inspectIndex(layout.indexPath)).toEqual({
      present: false,
      tables: [],
      hasRequiredTables: false,
      noteCount: 0,
      vectorCount: 0,
      storedDimension: null,
      embeddingModel: null,
      sectionCount: 0,
      sectionVectorCount: 0,
      linkCount: 0,
      deadAnchorSectionIds: [],
    });
  });

  test("an index from before the map tables is present but incomplete, its tables listed", () => {
    const layout = corpusLayout();
    const legacy = new Database(layout.indexPath, { create: true });
    legacy.run("CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, body)");
    legacy.run("CREATE TABLE meta (id TEXT PRIMARY KEY, type TEXT NOT NULL, staleness_boost REAL NOT NULL)");
    legacy.run("CREATE TABLE vec (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, embedding BLOB NOT NULL)");
    legacy.run("CREATE TABLE index_config (embedding_model TEXT NOT NULL)");
    legacy.close();

    const inspection = inspectIndex(layout.indexPath);

    expect(inspection.present).toBe(true);
    expect(inspection.hasRequiredTables).toBe(false);
    expect(inspection.tables).toContain("meta");
    expect(inspection.tables).not.toContain("map_meta");
    expect(inspection.noteCount).toBe(0);
    expect(inspection.sectionCount).toBe(0);
  });

  test("a rebuilt index counts notes, sections, vectors and links, and names the dead-anchor sections", async () => {
    const { projectRoot, commit } = await projectWithFile();
    const layout = corpusLayout();
    const note: Note = {
      frontmatter: { id: NOTE_ID, type: "bugfix", anchors: ["src/a.ts"], commit, created: "2026-07-06T10:00:00.000Z" },
      body: "note anchored at a",
    };
    writeFileSync(join(layout.notesDir, `${NOTE_ID}.md`), serializeNote(note));
    writeMapSection(mapLayoutOf(layout.mapDir), section("alpha", ["src/a.ts"], commit));
    writeMapSection(mapLayoutOf(layout.mapDir), section("gone", ["src/gone.ts"], commit));

    await rebuildLayout(layout, projectRoot);
    const inspection = inspectIndex(layout.indexPath);

    expect(inspection.present).toBe(true);
    expect(inspection.hasRequiredTables).toBe(true);
    expect(inspection.noteCount).toBe(1);
    expect(inspection.vectorCount).toBe(1);
    expect(inspection.sectionCount).toBe(2);
    expect(inspection.sectionVectorCount).toBe(2);
    expect(inspection.linkCount).toBe(1);
    expect(inspection.storedDimension).toBe(EMBEDDING_DIMENSION);
    expect(inspection.embeddingModel).toBe(EMBEDDING_MODEL);
    expect(inspection.deadAnchorSectionIds).toEqual(["gone"]);
    expect(DEAD_ANCHOR_SINK).toBe(-1);
  });

  test("the stored dimension is read from a section vector when no note has one", async () => {
    const { projectRoot, commit } = await projectWithFile();
    const layout = corpusLayout();
    writeMapSection(mapLayoutOf(layout.mapDir), section("alpha", ["src/a.ts"], commit));

    await rebuildLayout(layout, projectRoot);
    const inspection = inspectIndex(layout.indexPath);

    expect(inspection.noteCount).toBe(0);
    expect(inspection.vectorCount).toBe(0);
    expect(inspection.sectionVectorCount).toBe(1);
    expect(inspection.storedDimension).toBe(EMBEDDING_DIMENSION);
  });
});
