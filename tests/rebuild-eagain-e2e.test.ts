import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import type { Corpus } from "../src/corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, HttpEmbeddingsClient } from "../src/embeddings";
import type { FetchImplementation } from "../src/embeddings";
import { readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import { serializeNote } from "../src/note";

// The wire test of the staging_resolve incident, end to end on REAL modules: a real MCP client over
// a real server, a real project and corpus in real git repositories, the real HttpEmbeddingsClient.
// The only stand-in is the network — a fetch stub answering one-hot vectors.
//
// The corpus is sized past the macOS per-user process limit (4000): 1400 notes with 3 path anchors
// each, so every rebuild checks 4200 anchors with a git child or two apiece. It plays the incident
// and both fixes: an acceptance on that corpus rebuilds the index; a rebuild that fails after the
// commit returns the committed decision with its reason instead of a tool error; the next decision
// catches the index up. Unbounded, the same rebuild hits EAGAIN on macOS — on Linux the process
// limit is far higher, so there the scale half proves the path under the limit and the git adapter's
// own wiring spec is what tells a bounded runGit from an unbounded one.

// Thousands of real git children per rebuild: seconds idle, much more on a loaded machine.
setDefaultTimeout(300_000);

const fixedClock = () => new Date("2026-10-29T10:00:00.000Z");
const EMBEDDER_BASE_URL = "http://embedder.test";
const PROJECT_FILES = 100;
const SEEDED_NOTES = 1400;
const ANCHORS_PER_NOTE = 3;
const INDEX_NOT_REBUILT_LINE = "Index not rebuilt: unable to open database file";
const CATCH_UP_ADVICE_LINE =
  "The decision is committed — do not retry it; the index catches up on the next successful rebuild.";

// Tool-minted ids differ in their first eight characters, so each "Add note <short>" commit is its
// own; seeded notes take a disjoint id range.
function sequentialIds(): () => string {
  let counter = 1;
  return () => `${(counter++).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function seededId(index: number): string {
  return `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`;
}

function projectFile(index: number): string {
  return `src/file-${String(index % PROJECT_FILES).padStart(3, "0")}.ts`;
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// The network boundary, and the ONLY stand-in in this test: one-hot vectors keyed by the text.
const oneHotFetch: FetchImplementation = async (_url, init) => {
  const payload = JSON.parse(init.body) as { input: string[] };
  const embeddings = payload.input.map((text) => {
    const vector = new Array(EMBEDDING_DIMENSION).fill(0);
    vector[hashText(text) % EMBEDDING_DIMENSION] = 1;
    return vector;
  });
  return { ok: true, json: async () => ({ embeddings }) };
};

async function commitAll(repoDir: string, message: string): Promise<void> {
  await runGit(repoDir, ["add", "-A"]);
  const committed = await runGit(repoDir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
}

async function buildProject(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-eagain-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (let index = 0; index < PROJECT_FILES; index++) {
    writeFileSync(join(projectRoot, projectFile(index)), `export const value${index} = ${index};\n`);
  }
  await commitAll(projectRoot, "init");
  return { projectRoot, commit: (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim() };
}

// 1400 active notes, each anchored at HEAD to three tracked files, committed to the corpus at once.
// They are decisions on purpose: pattern and antipattern notes are anchor-neutral, and the rebuild
// skips their git scan entirely — a corpus of them would never spawn a single anchor check.
async function seedCorpus(corpus: Corpus, commit: string): Promise<void> {
  for (let index = 0; index < SEEDED_NOTES; index++) {
    const anchors = Array.from({ length: ANCHORS_PER_NOTE }, (_, offset) => projectFile(index + offset));
    const note = {
      frontmatter: { id: seededId(index), type: "decision" as const, anchors, commit, created: "2026-10-29T10:00:00.000Z" },
      body: `seeded decision number ${index} about module wiring`,
    };
    writeFileSync(join(corpus.notesDir, `${note.frontmatter.id}.md`), serializeNote(note));
  }
  await commitAll(corpus.corpusDir, "Seed notes");
}

async function connect(projectRoot: string, corpusHome: string): Promise<Client> {
  const embedder = new HttpEmbeddingsClient(EMBEDDER_BASE_URL, oneHotFetch, EMBEDDING_MODEL, "ollama");
  const server = createServer({ projectRoot, corpusHome, embeddings: embedder, idFactory: sequentialIds(), clock: fixedClock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
  return { text, isError: result.isError === true };
}

async function stagedNote(client: Client, body: string): Promise<string> {
  const { text } = await callTool(client, "remember", { type: "decision", body, anchors: [projectFile(0)] });
  const id = /Staged note (\S+) for human review/.exec(text)?.[1];
  if (id === undefined) throw new Error(`remember did not stage the note: ${text}`);
  return id;
}

async function corpusHead(corpus: Corpus): Promise<{ sha: string; subject: string }> {
  const head = await runGit(corpus.corpusDir, ["log", "-1", "--format=%H%n%s"]);
  const [sha, subject] = head.stdout.trim().split("\n");
  return { sha: sha!, subject: subject! };
}

function lastRebuild(events: StoredEvent[]): StoredEvent {
  const rebuilds = events.filter((event) => event.type === "rebuild");
  if (rebuilds.length === 0) throw new Error("no rebuild event was logged");
  return rebuilds.at(-1)!;
}

describe("staging_resolve on a corpus past the per-user process limit", () => {
  test("accepts rebuild the index, a failed rebuild after the commit stays a committed decision, the next one catches up", async () => {
    const { projectRoot, commit } = await buildProject();
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-eagain-e2e-home-"));
    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
    await seedCorpus(corpus, commit);
    const client = await connect(projectRoot, corpusHome);
    const firstBody = "Decision: quokka ledger reconciliation runs nightly";
    const secondBody = "Decision: pangolin cache eviction prefers oldest entries";
    const thirdBody = "Decision: axolotl retry budget doubles per attempt";
    const firstId = await stagedNote(client, firstBody);
    const secondId = await stagedNote(client, secondBody);
    const thirdId = await stagedNote(client, thirdBody);

    const first = await callTool(client, "staging_resolve", { id: firstId, decision: "accept" });

    expect(first.isError).toBe(false);
    expect(first.text).toBe(`Accepted note ${firstId}; committed ${(await corpusHead(corpus)).sha}.`);
    expect(lastRebuild(readEvents(corpus.eventsDir))).toMatchObject({ notes_n: SEEDED_NOTES + 1, dead_anchors_n: 0 });
    expect((await callTool(client, "recall", { query: firstBody })).text).toContain(`id: ${firstId}`);

    for (const path of [corpus.indexPath, `${corpus.indexPath}-wal`, `${corpus.indexPath}-shm`]) rmSync(path, { force: true });
    mkdirSync(corpus.indexPath);
    const second = await callTool(client, "staging_resolve", { id: secondId, decision: "accept" });

    expect(second.isError).toBe(false);
    const afterSecond = await corpusHead(corpus);
    expect(second.text.split("\n")).toEqual([
      `Accepted note ${secondId}; committed ${afterSecond.sha}.`,
      INDEX_NOT_REBUILT_LINE,
      CATCH_UP_ADVICE_LINE,
    ]);
    expect(afterSecond.subject).toBe(`Add note ${secondId.slice(0, 8)}`);
    expect(existsSync(join(corpus.notesDir, `${secondId}.md`))).toBe(true);
    const eventsAfterSecond = readEvents(corpus.eventsDir);
    expect(eventsAfterSecond.slice(-2).map((event) => [event.type, event.note_id ?? null])).toEqual([
      ["staging_resolve", secondId],
      ["rebuild_failed", null],
    ]);

    rmSync(corpus.indexPath, { recursive: true });
    const third = await callTool(client, "staging_resolve", { id: thirdId, decision: "accept" });

    expect(third.isError).toBe(false);
    expect(third.text).toBe(`Accepted note ${thirdId}; committed ${(await corpusHead(corpus)).sha}.`);
    const eventsAfterThird = readEvents(corpus.eventsDir);
    expect(lastRebuild(eventsAfterThird)).toMatchObject({ notes_n: SEEDED_NOTES + 3, dead_anchors_n: 0 });
    expect((await callTool(client, "recall", { query: secondBody })).text).toContain(`id: ${secondId}`);
    expect((await callTool(client, "recall", { query: thirdBody })).text).toContain(`id: ${thirdId}`);
    expect(readEvents(corpus.eventsDir).filter((event) => event.type === "tool_error")).toEqual([]);
  });
});
