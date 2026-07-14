import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, initRepo } from "./git";
import { resolveCorpus } from "./corpus";
import type { Corpus } from "./corpus";
import { serializeNote } from "./note";
import type { Note } from "./note";
import { rebuild } from "./index-db";
import { EventWriter } from "./events";
import { EMBEDDING_DIMENSION } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { runDoctor, renderDoctorReport } from "./doctor";
import type { DoctorReport, DoctorComponentReport } from "./doctor";

const CLOCK = (): Date => new Date("2026-07-06T10:00:00.000Z");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EXPECTED_COMPONENTS = [
  "corpus_root",
  "manifest",
  "note_store",
  "event_log",
  "index",
  "embeddings",
  "git",
];

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function hashTerm(term: string): number {
  let hash = 2166136261;
  for (let index = 0; index < term.length; index++) {
    hash ^= term.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const dimension = hashTerm(term) % EMBEDDING_DIMENSION;
    vector[dimension] = vector[dimension]! + 1;
  }
  return vector;
}

// A local Ollama stand-in that stores full-dimension vectors, exercising the healthy embeddings path
// without a live server.
function bagOfWordsClient(): EmbeddingsClient {
  return { embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

// Models Ollama being unreachable: any non-empty embed reports unavailable, like the real client on a
// refused connection.
function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

// Models a swapped embedding model whose output dimension no longer matches the stored vectors.
function wrongDimensionClient(dimension: number): EmbeddingsClient {
  return {
    embed: async (inputs) => ({
      available: true,
      embeddings: inputs.map(() => new Float32Array(dimension)),
      retries: 0,
    }),
  };
}

async function buildProjectRepo(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-doctor-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

async function buildHealthyCorpus(
  embeddings: EmbeddingsClient = bagOfWordsClient(),
): Promise<Corpus> {
  const { projectRoot, commit } = await buildProjectRepo();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-doctor-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: CLOCK });
  const note: Note = {
    frontmatter: {
      id: ulid(0),
      type: "pattern",
      anchors: ["src/a.ts"],
      commit,
      created: "2026-07-06T10:00:00.000Z",
    },
    body: "alpha beta gamma wiring diagnostic probe note",
  };
  writeFileSync(join(corpus.notesDir, `${note.frontmatter.id}.md`), serializeNote(note));
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-doctor",
    mnemeVersion: "0.1.0",
    clock: CLOCK,
  });
  await rebuild({ indexPath: corpus.indexPath, notesDir: corpus.notesDir, projectRoot, embeddings, eventWriter, clock: CLOCK });
  return corpus;
}

function byName(report: DoctorReport): Map<string, DoctorComponentReport> {
  return new Map(report.components.map((component) => [component.name, component]));
}

describe("runDoctor healthy wiring", () => {
  test("a well-formed corpus reports every component ok", async () => {
    const corpus = await buildHealthyCorpus();

    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: bagOfWordsClient() });

    expect(report.components.map((component) => component.name)).toEqual(EXPECTED_COMPONENTS);
    for (const component of report.components) {
      expect(component.status).toBe("ok");
    }
    expect(report.overall).toBe("ok");
  });
});

describe("runDoctor broken components are named, isolated, and typed", () => {
  test("an unreachable embedder fails the embeddings component without aborting the rest", async () => {
    const corpus = await buildHealthyCorpus();

    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: offlineClient() });

    const embeddings = byName(report).get("embeddings")!;
    expect(embeddings.status).toBe("fail");
    expect(embeddings.detail).toContain("unavailable");
    expect(report.overall).toBe("fail");
    expect(byName(report).get("manifest")!.status).toBe("ok");
    expect(byName(report).get("index")!.status).toBe("ok");
    expect(byName(report).get("git")!.status).toBe("ok");
  });

  test("a corrupt manifest fails the manifest component by name", async () => {
    const corpus = await buildHealthyCorpus();
    writeFileSync(corpus.manifestPath, "{ this is not valid json");

    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: bagOfWordsClient() });

    const manifest = byName(report).get("manifest")!;
    expect(manifest.status).toBe("fail");
    expect(manifest.detail.toLowerCase()).toContain("manifest");
    expect(report.overall).toBe("fail");
  });

  test("a manifest whose path belongs to another project fails as a munging collision", async () => {
    const corpus = await buildHealthyCorpus();
    writeFileSync(
      corpus.manifestPath,
      JSON.stringify({ path: "/somewhere/else", created: "2026-07-06T10:00:00.000Z", format_version: 2 }),
    );

    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: bagOfWordsClient() });

    const manifest = byName(report).get("manifest")!;
    expect(manifest.status).toBe("fail");
    expect(manifest.detail).toContain("collision");
  });

  test("an embedder whose dimension differs from the stored vectors degrades, named", async () => {
    const corpus = await buildHealthyCorpus();

    const report = await runDoctor({
      corpusDir: corpus.corpusDir,
      embedder: wrongDimensionClient(EMBEDDING_DIMENSION - 512),
    });

    const embeddings = byName(report).get("embeddings")!;
    expect(embeddings.status).toBe("degraded");
    expect(embeddings.detail).toContain("dimension");
    expect(report.overall).toBe("degraded");
  });

  test("a missing index degrades the index component (disposable cache), never fails it", async () => {
    const corpus = await buildHealthyCorpus();
    rmSync(corpus.indexPath, { force: true });

    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: bagOfWordsClient() });

    const index = byName(report).get("index")!;
    expect(index.status).toBe("degraded");
    expect(index.detail).toContain("absent");
    expect(report.overall).toBe("degraded");
  });

  test("a missing corpus directory fails corpus_root", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-doctor-home-"));
    const corpusDir = join(corpusHome, "does-not-exist");

    const report = await runDoctor({ corpusDir, embedder: bagOfWordsClient() });

    expect(byName(report).get("corpus_root")!.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });
});

describe("runDoctor output is machine-readable with a human render on top", () => {
  test("the report is a structured object, not just a string", async () => {
    const corpus = await buildHealthyCorpus();

    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: bagOfWordsClient() });

    expect(Array.isArray(report.components)).toBe(true);
    for (const component of report.components) {
      expect(typeof component.name).toBe("string");
      expect(["ok", "degraded", "fail"]).toContain(component.status);
      expect(typeof component.detail).toBe("string");
    }
    expect(["ok", "degraded", "fail"]).toContain(report.overall);
    expect(byName(report).get("embeddings")!.detail).toContain("dimension");
  });

  test("renderDoctorReport derives a string from the structured report", async () => {
    const corpus = await buildHealthyCorpus();
    const report = await runDoctor({ corpusDir: corpus.corpusDir, embedder: bagOfWordsClient() });

    const rendered = renderDoctorReport(report);

    expect(typeof rendered).toBe("string");
    for (const component of report.components) {
      expect(rendered).toContain(component.name);
      expect(rendered).toContain(component.detail);
    }
    expect(rendered).toContain("overall");
  });
});
