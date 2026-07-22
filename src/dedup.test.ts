import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeNote } from "./note";
import type { Note, NoteFrontmatter } from "./note";
import { rebuild } from "./index-db";
import { EMBEDDING_DIMENSION } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter } from "./events";
import { classifyCandidate, DEDUP_SUPERSEDE_THRESHOLD, DEDUP_NOOP_THRESHOLD } from "./dedup";
import { defaultConfig } from "./config";

// The live path threads config.dedup; these specs pin the historical bands, so the default
// thresholds ARE the fixture.
const THRESHOLDS = defaultConfig().dedup;

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function buildEventWriter(eventsDir: string): EventWriter {
  return new EventWriter(eventsDir, { sessionId: "s-dedup", mnemeVersion: "0.1.0", clock: fixedClock });
}

const EXISTING_BODY = "the existing note body";
const CANDIDATE_BODY = "the candidate note body";

const baseFrontmatter: NoteFrontmatter = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  type: "pattern",
  anchors: ["src/a.ts"],
  commit: "abc1234",
  created: "2026-07-06T10:00:00.000Z",
};

function vectorFrom(components: number[]): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  components.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

function keyedClient(byBody: Map<string, number[]>): EmbeddingsClient {
  return {
    embed: async (inputs) => {
      if (inputs.length === 0) return { available: true, embeddings: [], retries: 0 };
      return {
        available: true,
        embeddings: inputs.map((body) => {
          const components = byBody.get(body);
          if (components === undefined) throw new Error(`no vector for body: ${body}`);
          return vectorFrom(components);
        }),
        retries: 0,
      };
    },
  };
}

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

// The stored note holds e0 = (1, 0, ...); a candidate crafted as (leg, other, 0, ...) has cosine
// leg/hypotenuse with e0, so integer Pythagorean legs give an exact, float-stable similarity.
async function indexWithExistingVector(components: number[]): Promise<string> {
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-dedup-"));
  const notesDir = join(corpusDir, "notes");
  const eventsDir = join(corpusDir, "events");
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-dedup-proj-"));
  mkdirSync(notesDir);
  mkdirSync(eventsDir);
  const note: Note = { frontmatter: baseFrontmatter, body: EXISTING_BODY };
  writeFileSync(join(notesDir, `${baseFrontmatter.id}.md`), serializeNote(note));
  const indexPath = join(corpusDir, "index.db");
  await rebuild({
    indexPath,
    notesDir,
    projectRoot,
    embeddings: keyedClient(new Map([[EXISTING_BODY, components]])),
    eventWriter: buildEventWriter(eventsDir),
    clock: fixedClock,
  });
  return indexPath;
}

function candidateClient(components: number[]): EmbeddingsClient {
  return keyedClient(new Map([[CANDIDATE_BODY, components]]));
}

describe("classifyCandidate bands", () => {
  test("a similarity below the supersede threshold is a clean ADD carrying the neighbor", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const result = await classifyCandidate(indexPath, candidateClient([45, 28]), CANDIDATE_BODY, THRESHOLDS); // 45/53 = 0.849
    expect(result.kind).toBe("add");
    if (result.kind === "add") {
      expect(result.degraded).toBe(false);
      expect(result.neighborId).toBe(baseFrontmatter.id);
      expect(result.similarity).toBeCloseTo(45 / 53, 10);
    }
  });

  test("a similarity in the supersede band is a supersede offer carrying the neighbor", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const result = await classifyCandidate(indexPath, candidateClient([24, 7]), CANDIDATE_BODY, THRESHOLDS); // 24/25 = 0.96
    expect(result.kind).toBe("supersede_offer");
    if (result.kind === "supersede_offer") {
      expect(result.neighborId).toBe(baseFrontmatter.id);
      expect(result.similarity).toBeCloseTo(0.96, 5);
    }
  });

  test("a similarity at or above the noop threshold is a noop", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const result = await classifyCandidate(indexPath, candidateClient([40, 9]), CANDIDATE_BODY, THRESHOLDS); // 40/41 = 0.9756
    expect(result.kind).toBe("noop");
    if (result.kind === "noop") {
      expect(result.neighborId).toBe(baseFrontmatter.id);
      expect(result.similarity).toBeCloseTo(0.9756, 4);
    }
  });
});

describe("classifyCandidate boundaries", () => {
  test("just below 0.85 stays ADD while just above enters the supersede band", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const below = await classifyCandidate(indexPath, candidateClient([45, 28]), CANDIDATE_BODY, THRESHOLDS); // 0.849
    const above = await classifyCandidate(indexPath, candidateClient([75, 40]), CANDIDATE_BODY, THRESHOLDS); // 0.882
    expect(below.kind).toBe("add");
    expect(above.kind).toBe("supersede_offer");
    expect(DEDUP_SUPERSEDE_THRESHOLD).toBe(0.85);
  });

  test("just below 0.97 stays a supersede offer while at or above it is a noop", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const below = await classifyCandidate(indexPath, candidateClient([24, 7]), CANDIDATE_BODY, THRESHOLDS); // 0.96
    const above = await classifyCandidate(indexPath, candidateClient([40, 9]), CANDIDATE_BODY, THRESHOLDS); // 0.9756
    expect(below.kind).toBe("supersede_offer");
    expect(above.kind).toBe("noop");
    expect(DEDUP_NOOP_THRESHOLD).toBe(0.97);
  });

  test("an identical vector is a noop at the top of the band", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const result = await classifyCandidate(indexPath, candidateClient([1, 0]), CANDIDATE_BODY, THRESHOLDS); // cosine 1
    expect(result.kind).toBe("noop");
  });
});

describe("classifyCandidate degraded and empty", () => {
  test("an unavailable embedder degrades to a degraded ADD without consulting the index", async () => {
    const indexPath = await indexWithExistingVector([1, 0]);
    const result = await classifyCandidate(indexPath, offlineClient(), CANDIDATE_BODY, THRESHOLDS);
    expect(result).toEqual({ kind: "add", degraded: true, neighborId: null, similarity: null });
  });

  test("no stored neighbor yields a clean ADD", async () => {
    const corpusDir = mkdtempSync(join(tmpdir(), "mneme-dedup-empty-"));
    const indexPath = join(corpusDir, "index.db"); // never built -> nearestNeighbor undefined
    const result = await classifyCandidate(indexPath, candidateClient([1, 0]), CANDIDATE_BODY, THRESHOLDS);
    expect(result).toEqual({ kind: "add", degraded: false, neighborId: null, similarity: null });
  });
});
