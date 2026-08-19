import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "../../src/embeddings";
import type { EmbeddingsClient } from "../../src/embeddings";
import { readActiveNotes } from "../../src/index-db";
import { MAX_BODY_CODE_POINTS } from "../../src/note";
import { IngestError, chunkSessionText, ingestCase } from "./ingest";
import type { IngestedCase } from "./ingest";
import { parseLongmemevalS } from "./normalize";
import type { BenchCase } from "./normalize";

const projectRoot = process.cwd();

function readFixtureCases(): BenchCase[] {
  return parseLongmemevalS(
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "longmemeval-s-mini.json"), "utf8")),
  );
}

function updateCase(): BenchCase {
  const found = readFixtureCases().find((benchCase) => benchCase.id === "q-update-1");
  if (found === undefined) throw new Error("fixture lost its knowledge-update case");
  return found;
}

function hashClient(): EmbeddingsClient {
  return {
    async embed(inputs) {
      return {
        available: true,
        retries: 0,
        embeddings: inputs.map((input) => {
          const vector = new Float32Array(EMBEDDING_DIMENSION);
          for (let index = 0; index < input.length; index += 1) {
            const bucket = (input.charCodeAt(index) * 31 + index) % EMBEDDING_DIMENSION;
            vector[bucket]! += 1;
          }
          return vector;
        }),
      };
    },
  };
}

const offlineClient: EmbeddingsClient = {
  async embed() {
    return { available: false, retries: 1, embeddings: [] };
  },
};

function activeBodies(ingested: IngestedCase): string[] {
  return readActiveNotes(join(ingested.corpusDir, "notes")).map((note) => note.body);
}

describe("ingestCase", () => {
  test("coexist keeps both versions of an updated fact in an isolated temp corpus", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-bench-coexist-"));
    const ingested = await ingestCase(updateCase(), "coexist", {
      projectRoot,
      corpusHome,
      embeddings: hashClient(),
    });
    expect(ingested.corpusDir.startsWith(corpusHome)).toBe(true);
    const bodies = activeBodies(ingested);
    expect(bodies.some((body) => body.includes("Initech"))).toBe(true);
    expect(bodies.some((body) => body.includes("Acme"))).toBe(true);
    expect(ingested.sessions.map((session) => session.sessionId)).toEqual(["s-old-job", "s-new-job"]);
    for (const session of ingested.sessions) {
      expect(session.noteIds.length).toBeGreaterThan(0);
      expect(session.supersededNoteIds).toEqual([]);
    }
  });

  test("supersede excludes the outdated session's notes from the active set", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-bench-supersede-"));
    const ingested = await ingestCase(updateCase(), "supersede", {
      projectRoot,
      corpusHome,
      embeddings: hashClient(),
    });
    const bodies = activeBodies(ingested);
    expect(bodies.some((body) => body.includes("Acme"))).toBe(true);
    expect(bodies.some((body) => body.includes("Initech"))).toBe(false);
    const oldSession = ingested.sessions.find((session) => session.sessionId === "s-old-job")!;
    const newSession = ingested.sessions.find((session) => session.sessionId === "s-new-job")!;
    expect(newSession.supersededNoteIds).toEqual(oldSession.noteIds);
    const activeIds = readActiveNotes(join(ingested.corpusDir, "notes")).map((note) => note.frontmatter.id);
    for (const supersededId of newSession.supersededNoteIds) {
      expect(activeIds).not.toContain(supersededId);
    }
  });

  test("a session longer than the body cap becomes several notes, each within the cap", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-bench-chunk-"));
    const longText = Array.from({ length: 120 }, (_, index) => `user: long fact number ${index} about the corpus`).join(
      "\n",
    );
    const longCase: BenchCase = {
      id: "q-long",
      sessions: [{ id: "s-long", date: null, text: longText, entities: ["Long"] }],
      questions: [],
    };
    const ingested = await ingestCase(longCase, "coexist", { projectRoot, corpusHome, embeddings: hashClient() });
    const session = ingested.sessions[0]!;
    expect(session.noteIds.length).toBeGreaterThan(1);
    const bodies = activeBodies(ingested);
    expect(bodies.length).toBe(session.noteIds.length);
    for (const body of bodies) {
      expect([...body].length).toBeLessThanOrEqual(MAX_BODY_CODE_POINTS);
    }
  });

  test("an unavailable embedder aborts before any corpus is built", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-bench-degraded-"));
    await expect(
      ingestCase(updateCase(), "coexist", { projectRoot, corpusHome, embeddings: offlineClient }),
    ).rejects.toThrow(IngestError);
  });
});

describe("chunkSessionText", () => {
  test("short text stays a single chunk", () => {
    expect(chunkSessionText("user: hi\nassistant: hello")).toEqual(["user: hi\nassistant: hello"]);
  });

  test("minChunks forces aligned splitting for update chains", () => {
    const chunks = chunkSessionText("user: old fact\nassistant: noted", 2);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect([...chunk].length).toBeGreaterThan(0);
    }
  });

  test("line-boundary chunking preserves every line", () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const chunks = chunkSessionText(text, 1, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(text);
    for (const chunk of chunks) {
      expect([...chunk].length).toBeLessThanOrEqual(100);
    }
  });

  test("empty session text is refused", () => {
    expect(() => chunkSessionText("\n\n")).toThrow(IngestError);
  });
});
