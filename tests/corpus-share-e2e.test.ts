import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CONFIG_FILE_NAME, loadConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import type { Corpus } from "../src/corpus";
import { adoptCorpus } from "../src/corpus-adopt";
import { EMBEDDING_DIMENSION, HttpEmbeddingsClient } from "../src/embeddings";
import type { FetchImplementation } from "../src/embeddings";
import { EventWriter } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { recall } from "../src/recall";
import { remember, stagingResolve } from "../src/staging";
import type { StagingDeps } from "../src/staging";

// The wire test of the shared corpus: TWO working copies of one project, each with its own
// .mneme.json naming the SAME corpus, and a third corpus that drifted apart and is merged in. Every
// module is real — config, corpus resolution, staging with its human gate, the SQLite index, the
// corpus git repo, the event log and adoption. The single stand-in is the embedder's fetch at the
// network boundary; its vectors are one-hot keyed by the whole text (the bench-e2e precedent), which
// makes the cosine channel deterministic and inert so FTS alone decides ranking.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CORPUS_NAME = "shared-corpus";
const RECALL_BUDGET = 2000;
// Real git repositories, a real index rebuild per accepted note and a real adoption pass: seconds
// are the honest cost here, and the default 5s cap would make a loaded machine flip a coin.
const E2E_TIMEOUT_MS = 60000;

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(start: number): () => string {
  let counter = start;
  return () => ulid(counter++);
}

const fixedClock = () => new Date("2026-09-01T10:00:00.000Z");

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// A real Ollama-shaped HTTP exchange: the client posts {model, input}, this answers with the
// {embeddings: [...]} envelope it parses. One-hot by text hash: identical bodies land on the same
// axis (cosine 1.0, which is what dedup reads), different bodies stay orthogonal.
function oneHotFetch(): FetchImplementation {
  return async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { input: string[] };
    const embeddings = payload.input.map((text) => {
      const vector = new Array(EMBEDDING_DIMENSION).fill(0);
      vector[hashText(text) % EMBEDDING_DIMENSION] = 1;
      return vector;
    });
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function embedder(): HttpEmbeddingsClient {
  return new HttpEmbeddingsClient("http://embedder.test", oneHotFetch(), "test-model", "ollama");
}

// A working copy: a real git repository whose .mneme.json is written by the "user", exactly as the
// README instructs. Passing no name leaves the historical path-derived corpus.
async function workingCopy(prefix: string, corpusName?: string): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "shared.ts"), "export const shared = 1;\n");
  if (corpusName !== undefined) {
    writeFileSync(join(projectRoot, CONFIG_FILE_NAME), JSON.stringify({ corpus: { name: corpusName } }, null, 2));
  }
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

// The dependency assembly the server itself performs: config first, then the corpus it names.
async function sessionIn(projectRoot: string, corpusHome: string, idStart: number): Promise<StagingDeps> {
  const config = loadConfig(projectRoot, {});
  const corpus = await resolveCorpus(projectRoot, {
    corpusHome,
    corpusName: config.corpus.name,
    clock: fixedClock,
  });
  return {
    corpus,
    projectRoot,
    config,
    clock: fixedClock,
    idFactory: sequentialIds(idStart),
    embeddings: embedder(),
    eventWriter: new EventWriter(corpus.eventsDir, {
      sessionId: `s-${idStart}`,
      mnemeVersion: "0.1.7",
      clock: fixedClock,
    }),
  };
}

async function acceptNote(deps: StagingDeps, body: string, anchors: string[]): Promise<string> {
  const staged = await remember(deps, { type: "decision", body, anchors, source: "e2e" });
  if (staged.outcome !== "staged") throw new Error(`expected a staged note, got ${staged.outcome}`);
  const resolved = await stagingResolve(deps, staged.noteId, "accept");
  if (resolved.outcome !== "accepted") throw new Error(`expected an accepted note, got ${resolved.outcome}`);
  return staged.noteId;
}

async function recalledIds(deps: StagingDeps, query: string): Promise<string[]> {
  const db = new Database(deps.corpus.indexPath, { readonly: true });
  try {
    const result = await recall(
      { db, embeddings: deps.embeddings, eventWriter: deps.eventWriter, clock: fixedClock },
      query,
      RECALL_BUDGET,
      "tool-call",
    );
    return result.notes.map((note) => note.id);
  } finally {
    db.close();
  }
}

function corpusOf(deps: StagingDeps): Corpus {
  return deps.corpus;
}

describe("two working copies sharing one named corpus", () => {
  test("a note accepted in copy A is recalled from copy B, and a drifted corpus merges into both", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-share-home-"));
    const copyA = await workingCopy("mneme-share-a-", CORPUS_NAME);
    const copyB = await workingCopy("mneme-share-b-", CORPUS_NAME);

    const sessionA = await sessionIn(copyA, corpusHome, 1);
    const sessionB = await sessionIn(copyB, corpusHome, 50);

    // One corpus, two canonical roots: the shared directory is named, not derived from a path.
    expect(corpusOf(sessionB).corpusDir).toBe(join(corpusHome, CORPUS_NAME));
    expect(corpusOf(sessionA).corpusDir).toBe(corpusOf(sessionB).corpusDir);
    expect(corpusOf(sessionA).canonicalRoot).not.toBe(corpusOf(sessionB).canonicalRoot);

    const acceptedInA = await acceptNote(
      sessionA,
      "the migration runner replays events strictly in append order",
      ["src/shared.ts"],
    );

    expect(await recalledIds(sessionB, "migration runner replays events")).toContain(acceptedInA);

    // A third copy that never shared the name grew its own corpus the historical way.
    const drifted = await workingCopy("mneme-share-drifted-");
    const driftedSession = await sessionIn(drifted, corpusHome, 100);
    const acceptedInDrifted = await acceptNote(
      driftedSession,
      "the doctor never heals: it only reports what the wiring says",
      ["src/shared.ts"],
    );
    expect(corpusOf(driftedSession).corpusDir).not.toBe(corpusOf(sessionA).corpusDir);

    const adoption = await adoptCorpus(sessionB, corpusOf(driftedSession).corpusDir);

    expect(adoption.adoptedCount).toBe(1);
    expect(adoption.notes).toEqual([{ id: acceptedInDrifted, reason: "adopted" }]);
    // Both copies reach the adopted knowledge, because both read the one corpus it landed in.
    expect(await recalledIds(sessionA, "doctor never heals wiring")).toContain(acceptedInDrifted);
    expect(await recalledIds(sessionB, "doctor never heals wiring")).toContain(acceptedInDrifted);
    // And the note accepted before the merge is still there.
    expect(await recalledIds(sessionA, "migration runner replays events")).toContain(acceptedInA);

    // Re-adopting converges instead of duplicating, and the drifted corpus keeps its own copy.
    const second = await adoptCorpus(sessionB, corpusOf(driftedSession).corpusDir);
    expect(second.adoptedCount).toBe(0);
    expect(await recalledIds(driftedSession, "doctor never heals wiring")).toContain(acceptedInDrifted);
  }, E2E_TIMEOUT_MS);

  test("a copy without the key keeps its own path-derived corpus", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-share-home-"));
    const named = await workingCopy("mneme-share-named-", CORPUS_NAME);
    const unnamed = await workingCopy("mneme-share-plain-");

    const namedSession = await sessionIn(named, corpusHome, 200);
    const unnamedSession = await sessionIn(unnamed, corpusHome, 250);

    expect(corpusOf(namedSession).corpusDir).toBe(join(corpusHome, CORPUS_NAME));
    expect(corpusOf(unnamedSession).corpusDir).not.toBe(corpusOf(namedSession).corpusDir);

    const acceptedInNamed = await acceptNote(namedSession, "only the named corpus holds this", ["src/shared.ts"]);
    const acceptedInUnnamed = await acceptNote(unnamedSession, "the plain copy keeps its own memory", ["src/shared.ts"]);

    const fromUnnamed = await recalledIds(unnamedSession, "only the named corpus holds this");
    expect(fromUnnamed).not.toContain(acceptedInNamed);
    expect(await recalledIds(unnamedSession, "plain copy keeps its own memory")).toContain(acceptedInUnnamed);
    expect(await recalledIds(namedSession, "plain copy keeps its own memory")).not.toContain(acceptedInUnnamed);
  }, E2E_TIMEOUT_MS);
});
