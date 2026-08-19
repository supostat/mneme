import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "../../src/embeddings";
import type { EmbeddingsClient } from "../../src/embeddings";
import { ingestCase } from "./ingest";
import type { IngestMode } from "./ingest";
import { parseLongmemevalS } from "./normalize";
import type { BenchCase } from "./normalize";
import { abstained, aggregateMode, buildReport, renderReport } from "./report";
import { runCase } from "./run";
import type { CaseObservation } from "./run";

const projectRoot = process.cwd();

function fixtureCase(caseId: string): BenchCase {
  const cases = parseLongmemevalS(
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "longmemeval-s-mini.json"), "utf8")),
  );
  const found = cases.find((benchCase) => benchCase.id === caseId);
  if (found === undefined) throw new Error(`fixture lost case ${caseId}`);
  return found;
}

// One-hot vectors keyed by a hash of the WHOLE text: identical texts collide on purpose,
// distinct texts are orthogonal, so the cosine channel is deterministic and inert — the
// FTS channel alone drives ranking in these tests.
function oneHotClient(): EmbeddingsClient {
  return {
    async embed(inputs) {
      return {
        available: true,
        retries: 0,
        embeddings: inputs.map((input) => {
          const vector = new Float32Array(EMBEDDING_DIMENSION);
          vector[fnv1a(input) % EMBEDDING_DIMENSION] = 1;
          return vector;
        }),
      };
    },
  };
}

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

async function observe(caseId: string, mode: IngestMode): Promise<CaseObservation> {
  const benchCase = fixtureCase(caseId);
  const embeddings = oneHotClient();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-bench-measure-"));
  const ingested = await ingestCase(benchCase, mode, { projectRoot, corpusHome, embeddings });
  return runCase(ingested, benchCase.questions, { embeddings });
}

describe("measure", () => {
  test("Recall@k reads the candidates window at session level", async () => {
    const observation = await observe("q-standard-1", "coexist");
    expect(observation.questions[0]!.candidates.length).toBeGreaterThan(0);
    const report = aggregateMode("coexist", [observation]);
    expect(report.answerable.questions).toBe(1);
    expect(report.answerable.recallAtK).toEqual([
      { k: 5, value: 1 },
      { k: 10, value: 1 },
    ]);
    expect(report.answerable.abstained).toBe(0);
  });

  test("an abstention question yields an empty return or a pure cold-start floor", async () => {
    const observation = await observe("q-none-1_abs", "coexist");
    expect(abstained(observation.questions[0]!)).toBe(true);
    const report = aggregateMode("coexist", [observation]);
    expect(report.abstention).toEqual({ questions: 1, abstained: 1 });
  });

  test("the mode delta reflects supersede excluding the outdated session", async () => {
    const coexist = await observe("q-update-1", "coexist");
    const supersede = await observe("q-update-1", "supersede");

    const outdatedNoteIds = [...supersede.sessionByNoteId.entries()]
      .filter(([, sessionId]) => sessionId === "s-old-job")
      .map(([noteId]) => noteId);
    expect(outdatedNoteIds.length).toBeGreaterThan(0);
    for (const question of supersede.questions) {
      for (const candidate of question.candidates) {
        expect(outdatedNoteIds).not.toContain(candidate.id);
      }
    }

    const report = buildReport(
      {
        dataset: "longmemeval-s",
        datasetSha256: null,
        budget: 100_000,
        embedderModelConfigured: null,
        embedderModelIndexStamp: null,
      },
      new Map([
        ["coexist", [coexist]],
        ["supersede", [supersede]],
      ]),
    );
    const coexistMode = report.modes.find((mode) => mode.mode === "coexist")!;
    const supersedeMode = report.modes.find((mode) => mode.mode === "supersede")!;
    expect(coexistMode.knowledgeUpdate.staleHitAtK[0]!.value).toBe(1);
    expect(supersedeMode.knowledgeUpdate.staleHitAtK[0]!.value).toBe(0);
    expect(coexistMode.knowledgeUpdate.updateRecallAtK[0]!.value).toBe(1);
    expect(supersedeMode.knowledgeUpdate.updateRecallAtK[0]!.value).toBe(1);
    expect(report.delta).not.toBeNull();
    expect(report.delta!.staleHitAtK[0]!.value).toBe(-1);
    expect(report.delta!.updateRecallAtK[0]!.value).toBe(0);

    const rendered = renderReport(report);
    expect(rendered).toContain("delta (supersede − coexist");
    expect(rendered).toContain("recall budget (per call): 100000");
  });
});
