import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCorpusHome } from "../src/corpus";
import { EMBEDDING_DIMENSION, HttpEmbeddingsClient } from "../src/embeddings";
import type { FetchImplementation } from "../src/embeddings";
import { main } from "../scripts/bench/bench";
import { DATASET_SOURCES } from "../scripts/bench/download";

// The wire test: the WHOLE pipeline (dataset file → normalize → ingest in both modes →
// live recall → report) through the one-command entrypoint, with real modules, real temp
// corpora, real SQLite indexes and real corpus git — the ONLY mock is the embedder's
// fetch at the network boundary, returning deterministic one-hot vectors.

const projectRoot = process.cwd();

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function oneHot(text: string): number[] {
  const vector: number[] = new Array(EMBEDDING_DIMENSION).fill(0);
  vector[fnv1a(text) % EMBEDDING_DIMENSION] = 1;
  return vector;
}

const embeddingFetch: FetchImplementation = async (_url, init) => {
  const body = JSON.parse(init.body) as { input: string[] };
  return { ok: true, json: async () => ({ embeddings: body.input.map(oneHot) }) };
};

const downFetch: FetchImplementation = async () => ({ ok: false, json: async () => ({}) });

function oneHotClient(): HttpEmbeddingsClient {
  return new HttpEmbeddingsClient("http://bench.invalid", embeddingFetch, "bench-model", "ollama");
}

function fixtureDatasetsDir(): string {
  const datasetsDir = mkdtempSync(join(tmpdir(), "mneme-bench-e2e-datasets-"));
  const fixture = readFileSync(
    join(import.meta.dir, "..", "scripts", "bench", "fixtures", "longmemeval-s-mini.json"),
  );
  writeFileSync(join(datasetsDir, DATASET_SOURCES["longmemeval-s"].file), fixture);
  return datasetsDir;
}

function listNames(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe("bench end to end", () => {
  test(
    "the full both-modes run reports Recall@k, abstention and the mode delta without touching the working corpus home",
    async () => {
      const homeBefore = listNames(defaultCorpusHome());
      const runRoot = mkdtempSync(join(tmpdir(), "mneme-bench-e2e-run-"));
      const lines: string[] = [];
      const code = await main(["--dataset", "longmemeval-s", "--mode", "both"], {
        embeddings: oneHotClient(),
        datasetsDir: fixtureDatasetsDir(),
        runRoot,
        projectRoot,
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      const output = lines.join("\n");
      expect(output).toContain("Recall@5");
      expect(output).toContain("abstention (1): abstained 1/1");
      expect(output).toContain("delta (supersede − coexist");
      expect(output).toContain("stale hit@5 -1.000");
      expect(output).toContain("dataset sha256:");
      expect(output).toContain("recall budget (per call): 100000");

      // The corpora landed under the injected runRoot — one per mode per case —
      // and the default corpus home gained no new entry.
      expect(listNames(join(runRoot, "coexist")).length).toBe(3);
      expect(listNames(join(runRoot, "supersede")).length).toBe(3);
      expect(listNames(defaultCorpusHome())).toEqual(homeBefore);
    },
    60000,
  );

  test("a down embedder fails closed with exit 2 before building anything", async () => {
    const runRoot = mkdtempSync(join(tmpdir(), "mneme-bench-e2e-down-"));
    const lines: string[] = [];
    const code = await main(["--dataset", "longmemeval-s"], {
      embeddings: new HttpEmbeddingsClient("http://bench.invalid", downFetch, "bench-model", "ollama"),
      datasetsDir: fixtureDatasetsDir(),
      runRoot,
      projectRoot,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("embedder is unavailable");
    expect(listNames(runRoot)).toEqual([]);
  });

  test(
    "--cases caps the run to the first N cases and says so",
    async () => {
      const runRoot = mkdtempSync(join(tmpdir(), "mneme-bench-e2e-cases-"));
      const lines: string[] = [];
      const code = await main(["--dataset", "longmemeval-s", "--cases", "2"], {
        embeddings: oneHotClient(),
        datasetsDir: fixtureDatasetsDir(),
        runRoot,
        projectRoot,
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("capped to the first 2 of 3");
      expect(listNames(join(runRoot, "coexist")).length).toBe(2);
    },
    60000,
  );

  test("a missing dataset fails closed with exit 2 and the download instruction", async () => {
    const emptyDatasets = mkdtempSync(join(tmpdir(), "mneme-bench-e2e-empty-"));
    const lines: string[] = [];
    const code = await main(["--dataset", "longmemeval-s"], {
      embeddings: oneHotClient(),
      datasetsDir: emptyDatasets,
      projectRoot,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    const output = lines.join("\n");
    expect(output).toContain("dataset file missing");
    expect(output).toContain("bun scripts/bench/download.ts longmemeval-s");
  });
});
