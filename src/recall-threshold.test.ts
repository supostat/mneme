import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapLayoutOf } from "./corpus";
import { runGit, initRepo } from "./git";
import type { MapSection } from "./map/map-section";
import { writeMapSection } from "./map/map-store";
import { serializeNote } from "./note";
import type { Note, NoteFrontmatter } from "./note";
import { rebuild } from "./index-db";
import { recall, RECALL_BUNDLE_COSINE_THRESHOLD, RECALL_LOW_CONFIDENCE_FLOOR } from "./recall";
import type { RecallDeps } from "./recall";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";

// A deterministic corpus built at runtime, mirroring the float-exact vector technique the memory-steps
// boundary test uses: query [3, 4] (norm 5) against a note [1, 1, 3, 2, 1] (norm 4) has dot 7, so its
// cosine is exactly 7 / 20 = 0.35 in IEEE double; a 0.25 sixth component grows only the note's norm,
// sinking its cosine just below the threshold. No live embedder is required.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

const baseFrontmatter: NoteFrontmatter = {
  id: ulid(0),
  type: "pattern",
  anchors: ["src/a.ts"],
  commit: "abc1234",
  created: "2026-07-06T10:00:00.000Z",
};

interface NoteSpec {
  id: string;
  body: string;
  anchor: string;
  components: number[];
}

const FIXED_CLOCK = (): Date => new Date("2026-07-06T10:00:00.000Z");

function vectorFrom(components: number[]): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  components.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

// Maps each embedded text — the note bodies at rebuild and the query at recall — to its float-exact
// vector, so cosine scores land on the intended side of the threshold without a live embedder.
function keyedClient(byText: Map<string, number[]>): EmbeddingsClient {
  return {
    model: EMBEDDING_MODEL,
    embed: async (inputs) => {
      if (inputs.length === 0) return { available: true, embeddings: [], retries: 0 };
      return {
        available: true,
        embeddings: inputs.map((text) => {
          const components = byText.get(text);
          if (components === undefined) throw new Error(`no vector for text: ${text}`);
          return vectorFrom(components);
        }),
        retries: 0,
      };
    },
  };
}

function vectorMap(query: string, specs: NoteSpec[]): Map<string, number[]> {
  const byText = new Map<string, number[]>([[query, [3, 4]]]);
  for (const spec of specs) byText.set(spec.body, spec.components);
  return byText;
}

async function buildProjectRepo(fileNames: string[]): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-threshold-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (const name of fileNames) writeFileSync(join(projectRoot, name), `content of ${name}\n`);
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

async function setupIndex(
  specs: NoteSpec[],
  embeddings: EmbeddingsClient,
  sections: MapSection[] = [],
): Promise<{ indexPath: string; eventsDir: string }> {
  const { projectRoot, commit } = await buildProjectRepo(specs.map((spec) => spec.anchor));
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-threshold-"));
  const notesDir = join(corpusDir, "notes");
  const eventsDir = join(corpusDir, "events");
  mkdirSync(notesDir);
  mkdirSync(eventsDir);
  for (const spec of specs) {
    const note: Note = {
      frontmatter: { ...baseFrontmatter, id: spec.id, anchors: [spec.anchor], commit },
      body: spec.body,
    };
    writeFileSync(join(notesDir, `${spec.id}.md`), serializeNote(note));
  }
  const mapDir = join(corpusDir, "map");
  mkdirSync(join(mapDir, "domains"), { recursive: true });
  mkdirSync(join(mapDir, "flows"));
  // Sections take the repo's real HEAD as their commit, exactly as the notes above do.
  for (const section of sections) {
    writeMapSection(mapLayoutOf(mapDir), { ...section, frontmatter: { ...section.frontmatter, commit } });
  }
  const indexPath = join(corpusDir, "index.db");
  const buildEventsDir = mkdtempSync(join(tmpdir(), "mneme-threshold-build-"));
  const eventWriter = new EventWriter(buildEventsDir, {
    sessionId: "s-threshold-build",
    mnemeVersion: "0.1.0",
    clock: FIXED_CLOCK,
  });
  await rebuild({ indexPath, notesDir, mapDir, projectRoot, embeddings, eventWriter, clock: FIXED_CLOCK });
  return { indexPath, eventsDir };
}

function openRecall(indexPath: string, eventsDir: string, embeddings: EmbeddingsClient): RecallDeps {
  return {
    db: new Database(indexPath, { readonly: true }),
    embeddings,
    eventWriter: new EventWriter(eventsDir, {
      sessionId: "s-threshold",
      mnemeVersion: "0.1.0",
      clock: FIXED_CLOCK,
    }),
    clock: FIXED_CLOCK,
  };
}

function lastRecallEvent(eventsDir: string): StoredEvent {
  const recalls = readEvents(eventsDir).filter((event) => event.type === "recall");
  return recalls[recalls.length - 1]!;
}

function candidatesOf(event: StoredEvent): Array<Record<string, unknown>> {
  return event.candidates as Array<Record<string, unknown>>;
}

describe("recall threshold cut", () => {
  test("a cosine-only tail below the threshold is dropped while the relevant note and the boundary survive", async () => {
    const query = "payment refund";
    // One genuine fts match, one cosine-only note pinned at exactly 0.35, and a four-note tail below
    // it (the just-below sibling at ~0.3493 plus three orthogonal cosine-0 notes).
    const relevant: NoteSpec = { id: ulid(0), body: "payment refund ledger reconciliation", anchor: "src/relevant.ts", components: [3, 4] };
    const kept: NoteSpec = { id: ulid(1), body: "zebra quokka wombat burrow", anchor: "src/kept.ts", components: [1, 1, 3, 2, 1] };
    const sibling: NoteSpec = { id: ulid(2), body: "yak marmot lemur savanna", anchor: "src/sibling.ts", components: [1, 1, 3, 2, 1, 0.25] };
    const noise: NoteSpec[] = [
      { id: ulid(3), body: "koala dingo emu outback", anchor: "src/n3.ts", components: [0, 0, 1, 1] },
      { id: ulid(4), body: "otter badger stoat meadow", anchor: "src/n4.ts", components: [0, 0, 2, 1] },
      { id: ulid(5), body: "heron ibis egret wetland", anchor: "src/n5.ts", components: [0, 0, 1, 3] },
    ];
    const specs = [relevant, kept, sibling, ...noise];
    const client = keyedClient(vectorMap(query, specs));
    const { indexPath, eventsDir } = await setupIndex(specs, client);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", []);

    expect(result.degraded).toBe(false);
    expect(result.returnedIds).toContain(relevant.id);
    expect(result.returnedIds).toContain(kept.id);
    expect(result.returnedIds.length).toBe(2);
    for (const cut of [sibling, ...noise]) expect(result.returnedIds).not.toContain(cut.id);

    const keptNote = result.notes.find((note) => note.id === kept.id)!;
    expect(keptNote.cosine).toBe(RECALL_BUNDLE_COSINE_THRESHOLD);
    expect(keptNote.lowConfidence).toBe(false);
    expect(result.notes.find((note) => note.id === relevant.id)!.lowConfidence).toBe(false);

    // The threshold, not the budget, removed the sibling: it was admitted in budget yet its cosine
    // fell just short with no fts match to bypass the cut.
    const loggedSibling = candidatesOf(lastRecallEvent(eventsDir)).find((entry) => entry.id === sibling.id)!;
    expect(loggedSibling.fts_rank).toBeNull();
    expect(loggedSibling.in_budget).toBe(true);
    expect(loggedSibling.cosine as number).toBeGreaterThan(0);
    expect(loggedSibling.cosine as number).toBeLessThan(RECALL_BUNDLE_COSINE_THRESHOLD);
  });
});

describe("recall cold-start floor", () => {
  test("a corpus of only sub-threshold cosine notes returns the top-K marked low-confidence, not empty", async () => {
    const query = "payment refund";
    // Four cosine-only notes, all below the threshold, with strictly decreasing cosine so the top-K
    // by fused score is deterministic.
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "zebra quokka wombat", anchor: "src/c0.ts", components: [1, 1, 3, 2, 1, 0.25] },
      { id: ulid(1), body: "yak marmot lemur", anchor: "src/c1.ts", components: [1, 1, 3, 2, 1, 0.5] },
      { id: ulid(2), body: "koala dingo emu", anchor: "src/c2.ts", components: [1, 1, 3, 2, 1, 0.75] },
      { id: ulid(3), body: "otter badger stoat", anchor: "src/c3.ts", components: [1, 1, 3, 2, 1, 1] },
    ];
    const client = keyedClient(vectorMap(query, specs));
    const { indexPath, eventsDir } = await setupIndex(specs, client);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", []);

    expect(result.degraded).toBe(false);
    expect(result.notes.length).toBe(RECALL_LOW_CONFIDENCE_FLOOR);
    expect(result.notes.length).toBeGreaterThan(0);
    for (const note of result.notes) {
      expect(note.lowConfidence).toBe(true);
      expect(note.ftsRank).toBeNull();
      expect(note.cosine).not.toBeNull();
      expect(note.cosine!).toBeLessThan(RECALL_BUNDLE_COSINE_THRESHOLD);
    }
    // The three highest-cosine notes survive the floor; the lowest is left out, proving it is a top-K
    // slice rather than a pass-through of everything.
    expect(result.returnedIds).toEqual([ulid(0), ulid(1), ulid(2)]);
    expect(result.returnedIds).not.toContain(ulid(3));
  });
});

describe("recall fts bypass", () => {
  test("an fts match with cosine below the threshold is kept while a cosine-only note below it is cut", async () => {
    const query = "payment refund";
    // The fts note shares query terms but its vector is orthogonal to the query (cosine 0); the noise
    // note shares no terms and is also orthogonal. Only the lexical gate separates them.
    const ftsNote: NoteSpec = { id: ulid(0), body: "payment refund tactics", anchor: "src/fts.ts", components: [0, 0, 5, 5] };
    const cosineNoise: NoteSpec = { id: ulid(1), body: "zebra quokka wombat", anchor: "src/noise.ts", components: [0, 0, 1, 1] };
    const specs = [ftsNote, cosineNoise];
    const client = keyedClient(vectorMap(query, specs));
    const { indexPath, eventsDir } = await setupIndex(specs, client);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", []);

    expect(result.degraded).toBe(false);
    expect(result.returnedIds).toContain(ftsNote.id);
    expect(result.returnedIds).not.toContain(cosineNoise.id);

    const kept = result.notes.find((note) => note.id === ftsNote.id)!;
    expect(kept.ftsRank).not.toBeNull();
    expect(kept.cosine).toBe(0);
    expect(kept.cosine!).toBeLessThan(RECALL_BUNDLE_COSINE_THRESHOLD);
    expect(kept.lowConfidence).toBe(false);
  });
});

// The gap is decided on the same float-exact boundary as the cut: exactly 0.35 is memory, a hair
// below is the floor — shown, but a gap all the same.
describe("recall memory gap", () => {
  const query = "payment refund";
  const atThreshold: NoteSpec = { id: ulid(0), body: "zebra quokka wombat burrow", anchor: "src/kept.ts", components: [1, 1, 3, 2, 1] };
  const justBelow: NoteSpec = { id: ulid(1), body: "yak marmot lemur savanna", anchor: "src/sibling.ts", components: [1, 1, 3, 2, 1, 0.25] };

  function domainSection(body: string): MapSection {
    return { frontmatter: { id: "payments", kind: "domain", anchors: [], depends_on: [], terms: [], commit: "0000000" }, body };
  }

  test("a note exactly on the threshold closes the gap", async () => {
    const client = keyedClient(vectorMap(query, [atThreshold]));
    const { indexPath, eventsDir } = await setupIndex([atThreshold], client);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", []);

    expect(result.notes.map((note) => [note.id, note.cosine, note.lowConfidence])).toEqual([
      [atThreshold.id, RECALL_BUNDLE_COSINE_THRESHOLD, false],
    ]);
    expect(result.gap).toBe(false);
    expect(lastRecallEvent(eventsDir).gap).toBe(false);
  });

  test("a note just below the threshold comes back low-confidence and the gap stays open", async () => {
    const client = keyedClient(vectorMap(query, [justBelow]));
    const { indexPath, eventsDir } = await setupIndex([justBelow], client);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", []);

    expect(result.notes.map((note) => [note.id, note.lowConfidence])).toEqual([[justBelow.id, true]]);
    expect(result.notes[0]!.cosine!).toBeLessThan(RECALL_BUNDLE_COSINE_THRESHOLD);
    expect(result.gap).toBe(true);
    expect(lastRecallEvent(eventsDir).gap).toBe(true);
  });

  test("a section above the threshold closes the gap while every note stays below it", async () => {
    const sectionBody = "koala dingo emu outback";
    const byText = vectorMap(query, [justBelow]);
    byText.set(sectionBody, [1, 1, 3, 2, 1]);
    const client = keyedClient(byText);
    const { indexPath, eventsDir } = await setupIndex([justBelow], client, [domainSection(sectionBody)]);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", []);

    expect(result.sections.map((section) => [section.id, section.cosine])).toEqual([["payments", RECALL_BUNDLE_COSINE_THRESHOLD]]);
    expect(result.notes.map((note) => note.lowConfidence)).toEqual([true]);
    expect(result.gap).toBe(false);
    expect(lastRecallEvent(eventsDir).gap).toBe(false);
  });

  test("a note above the threshold that does not fit the budget is memory, not a gap", async () => {
    // 1500 ASCII bytes estimate to 375 tokens — the best note cannot fit a 100-token budget.
    const wide: NoteSpec = {
      id: ulid(0),
      body: `payment refund ledger ${"a".repeat(1478)}`,
      anchor: "src/wide.ts",
      components: [3, 4],
    };
    const client = keyedClient(vectorMap(query, [wide]));
    const { indexPath, eventsDir } = await setupIndex([wide], client);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100, "tool-call", []);

    expect(result.notes).toEqual([]);
    expect(result.gap).toBe(false);
    const event = lastRecallEvent(eventsDir);
    expect(event.gap).toBe(false);
    expect(candidatesOf(event).map((entry) => [entry.id, entry.in_budget, entry.fts_rank])).toEqual([[wide.id, false, 1]]);
  });

  test("under a domain filter the cold-start floor draws only from the domain's notes and the gap stays open", async () => {
    const inDomain: NoteSpec[] = [
      { id: ulid(0), body: "zebra quokka wombat", anchor: "src/c0.ts", components: [1, 1, 3, 2, 1, 0.25] },
      { id: ulid(1), body: "yak marmot lemur", anchor: "src/c1.ts", components: [1, 1, 3, 2, 1, 0.5] },
    ];
    // The closest notes of all sit outside the domain: an unscoped floor would pick them first.
    const outside: NoteSpec[] = [
      { id: ulid(2), body: "koala dingo emu", anchor: "src/c2.ts", components: [1, 1, 3, 2, 1, 0.1] },
      { id: ulid(3), body: "otter badger stoat", anchor: "src/c3.ts", components: [1, 1, 3, 2, 1, 0.15] },
    ];
    const specs = [...inDomain, ...outside];
    const sectionBody = "heron ibis egret";
    const byText = vectorMap(query, specs);
    byText.set(sectionBody, [0, 0, 0, 0, 0, 0, 1]);
    const client = keyedClient(byText);
    const domain: MapSection = {
      frontmatter: { id: "payments", kind: "domain", anchors: ["src/c0.ts", "src/c1.ts"], depends_on: [], terms: [], commit: "0000000" },
      body: sectionBody,
    };
    const { indexPath, eventsDir } = await setupIndex(specs, client, [domain]);

    const result = await recall(openRecall(indexPath, eventsDir, client), query, 100000, "tool-call", ["payments"]);

    expect(result.notes.map((note) => [note.id, note.lowConfidence])).toEqual([
      [ulid(0), true],
      [ulid(1), true],
    ]);
    expect(result.sections).toEqual([]);
    expect(result.gap).toBe(true);
    expect(lastRecallEvent(eventsDir).gap).toBe(true);
  });
});
