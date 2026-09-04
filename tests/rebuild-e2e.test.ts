import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import type { Corpus } from "../src/corpus";
import { runDoctor } from "../src/doctor";
import type { DoctorComponentReport, DoctorReport } from "../src/doctor";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, HttpEmbeddingsClient, REBUILD_EMBED_CHUNK_SIZE } from "../src/embeddings";
import type { FetchImplementation } from "../src/embeddings";
import { readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import { serializeNote } from "../src/note";
import type { Note } from "../src/note";

// The wire test of the chunked, in-place rebuild, end to end on REAL modules: a real MCP client
// over a real server, a real corpus in a real git repository, the real HttpEmbeddingsClient. The
// only stand-in is the network — a fetch stub that refuses exactly one chunk, the way a real
// embedder times out or dies mid-rebuild.
//
// It plays the failure the whole spec exists for and its recovery: the first recall rebuilds an
// index the embedder only half answers, the corpus is left PARTIALLY embedded rather than empty,
// the doctor names how many notes still lack vectors, and the very next rebuild — triggered by an
// ordinary note acceptance, with no manual step — asks only for the remainder and completes the
// index. Throughout, index.db keeps its inode: the file is rewritten, never replaced.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-09-04T10:00:00.000Z");
const E2E_TIMEOUT_MS = 60000;
const SEEDED_NOTES = 40;
// In the second chunk (bodies 16..31), so the first chunk is answered and kept while the rest is not.
const POISONED_NOTE = 20;
const EMBEDDER_BASE_URL = "http://embedder.test";

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(): () => string {
  let counter = 1;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
}

function seededBody(index: number): string {
  return `seeded corpus body number ${index} about rebuild wiring`;
}

const POISONED_BODY = seededBody(POISONED_NOTE);
const ACCEPTED_BODY = "a note accepted after the embedder came back, which triggers the completing rebuild";

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// The network boundary, and the ONLY stand-in in this test: one-hot vectors keyed by the text, and
// a refusal for any request carrying the poisoned body while the flag is up. Refusing the REQUEST
// (not the body) is what a real embedder does — the whole chunk is lost, not one input.
function poisonableFetch(state: { poisoned: boolean; requests: string[][] }): FetchImplementation {
  return async (_url, init) => {
    const payload = JSON.parse(init.body) as { input: string[] };
    state.requests.push(payload.input);
    if (state.poisoned && payload.input.includes(POISONED_BODY)) {
      return { ok: false, json: async () => ({}) };
    }
    const embeddings = payload.input.map((text) => {
      const vector = new Array(EMBEDDING_DIMENSION).fill(0);
      vector[hashText(text) % EMBEDDING_DIMENSION] = 1;
      return vector;
    });
    return { ok: true, json: async () => ({ embeddings }) };
  };
}

async function buildProject(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-rebuild-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "-A"]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return { projectRoot, commit: (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim() };
}

interface Wiring {
  client: Client;
  corpus: Corpus;
  embedder: HttpEmbeddingsClient;
  state: { poisoned: boolean; requests: string[][] };
}

// A corpus of 40 notes and a server wired to the real embeddings client over the poisonable fetch.
// No index exists yet: the first recall is what builds it.
async function corpusAwaitingItsFirstRebuild(): Promise<Wiring> {
  const { projectRoot, commit } = await buildProject();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-rebuild-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  for (let index = 0; index < SEEDED_NOTES; index++) {
    const note: Note = {
      frontmatter: { id: ulid(index), type: "pattern", anchors: ["src/a.ts"], commit, created: "2026-09-04T10:00:00.000Z" },
      body: seededBody(index),
    };
    writeFileSync(join(corpus.notesDir, `${note.frontmatter.id}.md`), serializeNote(note));
  }
  const state = { poisoned: true, requests: [] as string[][] };
  const embedder = new HttpEmbeddingsClient(EMBEDDER_BASE_URL, poisonableFetch(state), EMBEDDING_MODEL, "ollama");

  const server = createServer({ projectRoot, corpusHome, embeddings: embedder, idFactory: sequentialIds(), clock: fixedClock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, corpus, embedder, state };
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

function rebuildEvents(corpus: Corpus): StoredEvent[] {
  return readEvents(corpus.eventsDir).filter((event) => event.type === "rebuild");
}

function componentsOf(report: DoctorReport): Map<string, DoctorComponentReport> {
  return new Map(report.components.map((component) => [component.name, component]));
}

describe("chunked rebuild over a real server", () => {
  test(
    "an embedder that fails mid-rebuild leaves a partial index the doctor can name, and the next acceptance completes it",
    async () => {
      const { client, corpus, embedder, state } = await corpusAwaitingItsFirstRebuild();

      const firstAnswer = await callText(client, "recall", { query: "rebuild wiring" });

      expect(firstAnswer).toContain("seeded corpus body number");
      const partial = rebuildEvents(corpus)[0]!;
      expect(partial).toMatchObject({
        notes_n: SEEDED_NOTES,
        bodies_n: SEEDED_NOTES,
        chunks_n: 3,
        chunks_ok_n: 1,
        embedded_n: REBUILD_EMBED_CHUNK_SIZE,
      });
      expect(partial.ollama).toEqual({ available: false, retries: 1 });
      // Three chunk-sized requests — the first chunk, then the poisoned one twice (its retry) — and
      // then the single-input request recall makes for the query itself. The pass stopped at the
      // refusal: no request ever carried a body from the third chunk.
      expect(state.requests.map((request) => request.length)).toEqual([16, 16, 16, 1]);
      expect(state.requests.flat()).not.toContain(seededBody(2 * REBUILD_EMBED_CHUNK_SIZE));
      const inode = statSync(corpus.indexPath).ino;

      const partialReport = await runDoctor({ corpusDir: corpus.corpusDir, embedder });
      const partialComponents = componentsOf(partialReport);
      expect(partialComponents.get("index")!.status).toBe("degraded");
      expect(partialComponents.get("index")!.detail).toBe(
        "index holds 40 note(s), 24 without stored vectors (the next rebuild embeds the rest)",
      );
      expect(partialComponents.get("embeddings")!.status).toBe("ok");
      expect(partialReport.overall).toBe("degraded");

      // The embedder comes back, and an ordinary acceptance — no manual repair step — rebuilds.
      state.poisoned = false;
      state.requests.length = 0;
      const staged = await callText(client, "remember", { type: "pattern", body: ACCEPTED_BODY, anchors: ["src/a.ts"] });
      const noteId = /Staged note (\S+) for human review/.exec(staged)![1]!;
      await callText(client, "staging_resolve", { id: noteId, decision: "accept" });

      const completing = rebuildEvents(corpus).at(-1)!;
      expect(completing).toMatchObject({
        notes_n: SEEDED_NOTES + 1,
        bodies_n: SEEDED_NOTES + 1 - REBUILD_EMBED_CHUNK_SIZE,
        chunks_n: 2,
        chunks_ok_n: 2,
        embedded_n: SEEDED_NOTES + 1,
      });
      expect(completing.ollama).toEqual({ available: true, retries: 0 });

      const secondAnswer = await callText(client, "recall", { query: "rebuild wiring" });
      expect(secondAnswer).not.toContain("degraded mode");
      const healedComponents = componentsOf(await runDoctor({ corpusDir: corpus.corpusDir, embedder }));
      expect(healedComponents.get("index")!.detail).toBe("41 note(s), 41 vector(s)");
      expect(healedComponents.get("index")!.status).toBe("ok");
      // The index file was rewritten in place by both rebuilds — never deleted and recreated.
      expect(statSync(corpus.indexPath).ino).toBe(inode);
    },
    E2E_TIMEOUT_MS,
  );
});
