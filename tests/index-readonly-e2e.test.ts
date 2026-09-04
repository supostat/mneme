import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import type { Corpus } from "../src/corpus";
import { EMBEDDING_DIMENSION } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { initRepo, runGit } from "../src/git";
import { inspectIndex } from "../src/index-inspect";
import { createServer } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";
import { serializeNote } from "../src/note";
import type { Note } from "../src/note";
import { isAppleSqlite } from "./sqlite-build";

// The wire test of the reader-mode change, end to end on REAL modules: a real MCP client over a
// real server, a real git repository, a real corpus. It plays the rollout an existing corpus goes
// through — a .gitignore written by an older engine, then the first tool call of the new one — and
// proves three things without touching the Apple-only failure (that one lives in src/index-db.test.ts
// under its named skip): recall reads the WAL index, the appended ignore rules cover the sidecars on
// every build, and a deleted index still triggers a rebuild instead of a zero-byte file. Whether the
// sidecars are still on disk after the read is a property of the SQLite build — Apple keeps them,
// upstream deletes them when the last connection closes — so that expectation is compared against
// the platform, never assumed. The only stand-in is the embedder.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-09-04T10:00:00.000Z");
const E2E_TIMEOUT_MS = 60000;
const NOTE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const NOTE_BODY = "wiring diagnostic probe note for the readonly index reader";
// What an engine older than the sidecar rules wrote, plus a line a person added by hand.
const LEGACY_GITIGNORE = "index.db\nevents/\nstaging/\n*.dedup.json\nscratch/\n";
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(): () => string {
  let counter = 1;
  return () => ulid(counter++);
}

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

function bagClient(): EmbeddingsClient {
  return { embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function gitCommitAll(repoDir: string, subject: string): Promise<void> {
  await runGit(repoDir, ["add", "-A"]);
  const committed = await runGit(repoDir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", subject]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
}

async function buildProject(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-ro-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await gitCommitAll(projectRoot, "init");
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

interface Rollout {
  client: Client;
  corpus: Corpus;
}

// A corpus that predates the sidecar rules: one note, the legacy .gitignore, and a git baseline
// committed BEFORE the new engine touches it — so whatever `git status` shows afterwards is exactly
// what the new engine changed.
async function corpusFromBeforeTheChange(): Promise<Rollout> {
  const { projectRoot, commit } = await buildProject();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-ro-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const note: Note = {
    frontmatter: { id: NOTE_ID, type: "pattern", anchors: ["src/a.ts"], commit, created: "2026-09-04T10:00:00.000Z" },
    body: NOTE_BODY,
  };
  writeFileSync(join(corpus.notesDir, `${NOTE_ID}.md`), serializeNote(note));
  writeFileSync(join(corpus.corpusDir, ".gitignore"), LEGACY_GITIGNORE);
  await gitCommitAll(corpus.corpusDir, "baseline before the sidecar rules");

  const client = await connect({ projectRoot, corpusHome, embeddings: bagClient(), idFactory: sequentialIds(), clock: fixedClock });
  return { client, corpus };
}

async function recallText(client: Client, query: string): Promise<string> {
  const result = await client.callTool({ name: "recall", arguments: { query } });
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

async function isIgnored(repoDir: string, relativePath: string): Promise<boolean> {
  return (await runGit(repoDir, ["check-ignore", "-q", relativePath])).exitCode === 0;
}

describe("index readers over a real server", () => {
  test(
    "the first tool call appends the sidecar rules to a legacy .gitignore, recall reads the WAL index, and the sidecars it leaves are ignored",
    async () => {
      const { client, corpus } = await corpusFromBeforeTheChange();

      const answer = await recallText(client, "wiring diagnostic probe");

      expect(answer).toContain(NOTE_BODY);
      expect(readFileSync(join(corpus.corpusDir, ".gitignore"), "utf8")).toBe(`${LEGACY_GITIGNORE}index.db-wal\nindex.db-shm\n`);
      for (const suffix of SIDECAR_SUFFIXES) {
        expect(existsSync(`${corpus.indexPath}${suffix}`)).toBe(isAppleSqlite());
        expect(await isIgnored(corpus.corpusDir, `index.db${suffix}`)).toBe(true);
      }
      // The ONLY change git can see is the appended .gitignore: the rules were written before the
      // reader opened the index, so whatever this build leaves on disk — both sidecars, or nothing —
      // is already ignored, and the status is the same on Apple and upstream alike.
      const status = (await runGit(corpus.corpusDir, ["status", "--porcelain"])).stdout.trimEnd();
      expect(status).toBe(" M .gitignore");
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "a deleted index is rebuilt by the next recall — create: false left the absent-file signal intact",
    async () => {
      const { client, corpus } = await corpusFromBeforeTheChange();
      await recallText(client, "wiring diagnostic probe");
      rmSync(corpus.indexPath);
      for (const suffix of SIDECAR_SUFFIXES) rmSync(`${corpus.indexPath}${suffix}`, { force: true });
      expect(existsSync(corpus.indexPath)).toBe(false);

      const answer = await recallText(client, "wiring diagnostic probe");

      expect(answer).toContain(NOTE_BODY);
      expect(statSync(corpus.indexPath).size).toBeGreaterThan(0);
      const inspection = inspectIndex(corpus.indexPath);
      expect(inspection.hasRequiredTables).toBe(true);
      expect(inspection.noteCount).toBe(1);
    },
    E2E_TIMEOUT_MS,
  );
});
