import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, initRepo } from "./git";
import { serializeNote } from "./note";
import type { Note, NoteFrontmatter } from "./note";
import { rebuild, dumpIndex, dumpVectors, nearestNeighbor } from "./index-db";
import type { RebuildDeps } from "./index-db";
import { OllamaEmbeddingsClient, EMBEDDING_DIMENSION, OLLAMA_BASE_URL } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

interface RebuildBase {
  indexPath: string;
  notesDir: string;
  projectRoot: string;
  embeddings: EmbeddingsClient;
}

// Every rebuild() call needs an EventWriter (rebuild now emits a rebuild event) and a clock. This
// factory pairs a base with a fresh temp-dir writer + the fixed clock; a reused deps object keeps a
// stable writer across repeated rebuilds.
function rebuildDeps(base: RebuildBase): RebuildDeps {
  const eventsDir = mkdtempSync(join(tmpdir(), "mneme-index-events-"));
  const eventWriter = new EventWriter(eventsDir, { sessionId: "s-index", mnemeVersion: "0.1.0", clock: fixedClock });
  return { ...base, eventWriter, clock: fixedClock };
}

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

function note(overrides: Partial<NoteFrontmatter>, body: string): Note {
  return { frontmatter: { ...baseFrontmatter, ...overrides }, body };
}

function writeNote(notesDir: string, value: Note): void {
  writeFileSync(join(notesDir, `${value.frontmatter.id}.md`), serializeNote(value));
}

function makeCorpus(): { notesDir: string; indexPath: string } {
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-index-"));
  const notesDir = join(corpusDir, "notes");
  mkdirSync(notesDir);
  return { notesDir, indexPath: join(corpusDir, "index.db") };
}

async function buildProjectRepo(fileNames: string[]): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-proj-"));
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

interface EmbedLog {
  calls: string[][];
}

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

function jitterClient(log: EmbedLog): EmbeddingsClient {
  let generation = 0;
  return {
    embed: async (inputs) => {
      log.calls.push(inputs);
      if (inputs.length === 0) return { available: true, embeddings: [], retries: 0 };
      generation++;
      const embeddings = inputs.map((_text, index) => {
        const vector = new Float32Array(EMBEDDING_DIMENSION);
        for (let dimension = 0; dimension < EMBEDDING_DIMENSION; dimension++) {
          vector[dimension] = Math.sin(generation * 131 + index * 7 + dimension) * 0.01;
        }
        return vector;
      });
      return { available: true, embeddings, retries: 0 };
    },
  };
}

function configCount(indexPath: string): number {
  const db = new Database(indexPath, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS count FROM index_config").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

const OLLAMA_REACHABLE = await probeOllama();

describe("rebuild FTS and meta determinism", () => {
  test("two consecutive offline rebuilds produce byte-identical FTS and meta", async () => {
    const { projectRoot, commit } = await buildProjectRepo(["src/a.ts", "src/b.ts"]);
    const corpus = makeCorpus();
    writeNote(corpus.notesDir, note({ id: ulid(0), anchors: ["src/a.ts"], commit }, "payment ledger essence"));
    writeNote(corpus.notesDir, note({ id: ulid(1), anchors: ["src/b.ts"], commit }, "refund workflow essence"));
    const deps = rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient() });

    await rebuild(deps);
    const first = dumpIndex(corpus.indexPath);
    await rebuild(deps);
    const second = dumpIndex(corpus.indexPath);

    expect(second).toBe(first);
    expect(dumpVectors(corpus.indexPath)).toBe("[]");
    expect(configCount(corpus.indexPath)).toBe(0);
  });
});

describe("rebuild supersede exclusion", () => {
  test("a superseded note is dropped, keeping only its successor", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "original insight"));
    writeNote(corpus.notesDir, note({ id: ulid(1), supersedes: ulid(0) }, "revised insight"));
    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient() }));

    const ids = (JSON.parse(dumpIndex(corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual([ulid(1)]);
  });

  test("a three-link supersede chain keeps only the final tip", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "v1"));
    writeNote(corpus.notesDir, note({ id: ulid(1), supersedes: ulid(0) }, "v2"));
    writeNote(corpus.notesDir, note({ id: ulid(2), supersedes: ulid(1) }, "v3"));
    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient() }));

    const ids = (JSON.parse(dumpIndex(corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual([ulid(2)]);
  });
});

describe("rebuild non-markdown filter", () => {
  test("non-markdown directory entries are ignored and only the .md note is indexed", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "the only real note"));
    writeFileSync(join(corpus.notesDir, ".DS_Store"), "\0\0 binary junk not a note");
    writeFileSync(join(corpus.notesDir, "notes.txt"), "plain text that is not a note");

    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient() }));

    const ids = (JSON.parse(dumpIndex(corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual([ulid(0)]);
  });
});

describe("rebuild empty corpus", () => {
  test("an empty notes directory yields empty dumps and exercises embed([]) without crashing", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    const log: EmbedLog = { calls: [] };

    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: jitterClient(log) }));

    expect(dumpIndex(corpus.indexPath)).toBe("[]");
    expect(dumpVectors(corpus.indexPath)).toBe("[]");
    expect(configCount(corpus.indexPath)).toBe(0);
    expect(log.calls).toEqual([[]]);
  });
});

describe("rebuild corrupt index recovery", () => {
  test("a corrupt index.db is discarded and rebuild degrades to a clean from-scratch build", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "durable note body"));
    const deps = rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient() });

    await rebuild(deps);
    const healthy = dumpIndex(corpus.indexPath);

    writeFileSync(corpus.indexPath, "not a sqlite database at all");
    await expect(rebuild(deps)).resolves.toBeUndefined();

    expect(dumpIndex(corpus.indexPath)).toBe(healthy);
    const ids = (JSON.parse(dumpIndex(corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual([ulid(0)]);
  });
});

describe("rebuild content-hash embedding cache", () => {
  test("a re-run without deletion reuses cached vectors byte-for-byte and re-embeds nothing", async () => {
    const { projectRoot, commit } = await buildProjectRepo(["src/a.ts", "src/b.ts"]);
    const corpus = makeCorpus();
    writeNote(corpus.notesDir, note({ id: ulid(0), anchors: ["src/a.ts"], commit }, "alpha body"));
    writeNote(corpus.notesDir, note({ id: ulid(1), anchors: ["src/b.ts"], commit }, "beta body"));
    const log: EmbedLog = { calls: [] };
    const embeddings = jitterClient(log);
    const deps = rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings });

    await rebuild(deps);
    const first = dumpVectors(corpus.indexPath);
    log.calls = [];
    await rebuild(deps);
    const second = dumpVectors(corpus.indexPath);

    expect(second).toBe(first);
    expect(log.calls).toEqual([[]]);
    expect(configCount(corpus.indexPath)).toBe(1);
  });

  test("a shared body across two notes writes two vec rows with identical bytes", async () => {
    const { projectRoot, commit } = await buildProjectRepo(["src/a.ts", "src/b.ts"]);
    const corpus = makeCorpus();
    writeNote(corpus.notesDir, note({ id: ulid(0), anchors: ["src/a.ts"], commit }, "shared body text"));
    writeNote(corpus.notesDir, note({ id: ulid(1), anchors: ["src/b.ts"], commit }, "shared body text"));
    const log: EmbedLog = { calls: [] };

    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: jitterClient(log) }));

    const rows = JSON.parse(dumpVectors(corpus.indexPath)) as Array<{ content_hash: string; embedding: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.content_hash).toBe(rows[1]!.content_hash);
    expect(rows[0]!.embedding).toBe(rows[1]!.embedding);
    expect(log.calls[0]).toEqual(["shared body text"]);
  });

  test("a changed embedding model forces a full re-embed", async () => {
    const { projectRoot, commit } = await buildProjectRepo(["src/a.ts", "src/b.ts"]);
    const corpus = makeCorpus();
    writeNote(corpus.notesDir, note({ id: ulid(0), anchors: ["src/a.ts"], commit }, "alpha body"));
    writeNote(corpus.notesDir, note({ id: ulid(1), anchors: ["src/b.ts"], commit }, "beta body"));
    const log: EmbedLog = { calls: [] };
    const deps = rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: jitterClient(log) });

    await rebuild(deps);
    const tamper = new Database(corpus.indexPath);
    tamper.run("UPDATE index_config SET embedding_model = 'a-different-model'");
    tamper.close();
    log.calls = [];
    await rebuild(deps);

    expect(log.calls.flat().sort()).toEqual(["alpha body", "beta body"]);
  });
});

function vectorFrom(components: number[]): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  components.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

function keyedVectorClient(byBody: Map<string, number[]>): EmbeddingsClient {
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

describe("rebuild telemetry event", () => {
  test("emits a rebuild event with per-note staleness, dead anchors, and ollama availability", async () => {
    const { projectRoot, commit } = await buildProjectRepo(["src/a.ts"]);
    const corpus = makeCorpus();
    writeNote(corpus.notesDir, note({ id: ulid(0), anchors: ["src/a.ts"], commit }, "alpha body"));
    writeNote(corpus.notesDir, note({ id: ulid(1), anchors: ["src/gone.ts"], commit }, "beta body"));
    const eventsDir = mkdtempSync(join(tmpdir(), "mneme-index-events-"));
    const eventWriter = new EventWriter(eventsDir, { sessionId: "s-index", mnemeVersion: "0.1.0", clock: fixedClock });
    const embeddings = keyedVectorClient(new Map([["alpha body", [1, 0]], ["beta body", [0, 1]]]));

    await rebuild({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings, eventWriter, clock: fixedClock });

    const events = readEvents(eventsDir).filter((event) => event.type === "rebuild");
    expect(events.length).toBe(1);
    const emitted = events[0]!;
    expect(emitted.notes_n).toBe(2);
    expect(emitted.dead_anchors_n).toBe(1);
    expect(emitted.staleness).toEqual([0, -1]);
    expect(emitted.embedded_n).toBe(2);
    expect(emitted.duration_ms).toBe(0);
    const ollama = emitted.ollama as { available: boolean; retries: number };
    expect(ollama.available).toBe(true);
    expect(ollama.retries).toBe(0);
  });

  test("an offline embeddings client yields zero embedded notes and unavailable ollama", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "alpha body"));
    writeNote(corpus.notesDir, note({ id: ulid(1) }, "beta body"));
    const eventsDir = mkdtempSync(join(tmpdir(), "mneme-index-events-"));
    const eventWriter = new EventWriter(eventsDir, { sessionId: "s-index", mnemeVersion: "0.1.0", clock: fixedClock });

    await rebuild({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient(), eventWriter, clock: fixedClock });

    const events = readEvents(eventsDir).filter((event) => event.type === "rebuild");
    expect(events.length).toBe(1);
    const emitted = events[0]!;
    expect(emitted.notes_n).toBe(2);
    expect(emitted.embedded_n).toBe(0);
    expect((emitted.ollama as { available: boolean; retries: number }).available).toBe(false);
  });
});

describe("nearestNeighbor", () => {
  test("returns the note whose stored vector is closest by cosine", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "alpha body"));
    writeNote(corpus.notesDir, note({ id: ulid(1) }, "beta body"));
    const client = keyedVectorClient(new Map([["alpha body", [1, 0]], ["beta body", [0, 1]]]));
    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: client }));

    const result = nearestNeighbor(corpus.indexPath, vectorFrom([0.9, 0.1]));

    expect(result?.id).toBe(ulid(0));
    expect(result!.similarity).toBeGreaterThan(0.9);
  });

  test("breaks ties on equal similarity by ascending id", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(1) }, "shared body"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "shared body"));
    const client = keyedVectorClient(new Map([["shared body", [1, 1]]]));
    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: client }));

    const result = nearestNeighbor(corpus.indexPath, vectorFrom([1, 1]));

    expect(result?.id).toBe(ulid(0));
  });

  test("returns undefined for a missing index path", () => {
    expect(nearestNeighbor(join(tmpdir(), "mneme-absent-index.db"), vectorFrom([1, 0]))).toBeUndefined();
  });

  test("returns undefined when the vector table holds zero rows", async () => {
    const corpus = makeCorpus();
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeNote(corpus.notesDir, note({ id: ulid(0) }, "no vectors stored offline"));
    await rebuild(rebuildDeps({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings: offlineClient() }));

    expect(nearestNeighbor(corpus.indexPath, vectorFrom([1, 0]))).toBeUndefined();
  });
});

describe("rebuild with real Ollama", () => {
  test.skipIf(!OLLAMA_REACHABLE)(
    "cache reuse across a re-run is byte-identical with the live model",
    async () => {
      const { projectRoot, commit } = await buildProjectRepo(["src/a.ts"]);
      const corpus = makeCorpus();
      writeNote(corpus.notesDir, note({ id: ulid(0), anchors: ["src/a.ts"], commit }, "durable ollama vector body"));
      const deps = rebuildDeps({
        indexPath: corpus.indexPath,
        notesDir: corpus.notesDir,
        projectRoot,
        embeddings: new OllamaEmbeddingsClient(),
      });

      await rebuild(deps);
      const first = dumpVectors(corpus.indexPath);
      await rebuild(deps);
      const second = dumpVectors(corpus.indexPath);

      expect(first).not.toBe("[]");
      expect(second).toBe(first);
    },
  );
});
