#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { HttpEmbeddingsClient } from "../../src/embeddings";
import type { EmbeddingsClient } from "../../src/embeddings";
import { DATASET_SOURCES, DEFAULT_DATASETS_DIR } from "./download";
import { IngestError, ingestCase } from "./ingest";
import type { IngestMode } from "./ingest";
import { BENCH_DATASET_IDS, parseDataset } from "./normalize";
import type { BenchDatasetId } from "./normalize";
import { buildReport, renderReport } from "./report";
import { BENCH_RECALL_BUDGET, BenchRunError, runCase } from "./run";
import type { CaseObservation } from "./run";

// The one-command benchmark orchestrator: dataset file → normalize → per-case isolated
// ingest → live-recall run → deterministic report. Exit codes follow the replay.ts
// convention: 2 for usage and unmet preconditions (dataset missing, embedder down),
// 1 for a failure mid-measurement, 0 for a completed report.

const USAGE =
  "usage: bun scripts/bench/bench.ts --dataset <locomo|longmemeval-s> [--mode coexist|supersede|both] [--cases N]";

const MODES = ["coexist", "supersede", "both"] as const;
type ModeArgument = (typeof MODES)[number];

export interface BenchDeps {
  embeddings?: EmbeddingsClient;
  datasetsDir?: string;
  runRoot?: string;
  projectRoot?: string;
  log?: (line: string) => void;
}

export async function main(argv: string[], deps: BenchDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const parsed = parseArguments(argv);
  if (parsed === undefined) {
    log(USAGE);
    return 2;
  }
  const { dataset, mode } = parsed;
  if (dataset === "locomo" && mode !== "coexist") {
    log("locomo carries no knowledge-update labels; only --mode coexist is meaningful for it");
    return 2;
  }
  const datasetsDir = deps.datasetsDir ?? DEFAULT_DATASETS_DIR;
  const datasetPath = join(datasetsDir, DATASET_SOURCES[dataset].file);
  if (!existsSync(datasetPath)) {
    log(`dataset file missing: ${datasetPath}`);
    log(`fetch it with: bun scripts/bench/download.ts ${dataset}`);
    log(`or manually: ${DATASET_SOURCES[dataset].manual}; place the file at ${datasetPath}`);
    return 2;
  }
  const datasetBytes = readFileSync(datasetPath);
  const allCases = parseDataset(dataset, JSON.parse(datasetBytes.toString("utf8")));
  const cases = parsed.cases === undefined ? allCases : allCases.slice(0, parsed.cases);
  if (cases.length < allCases.length) {
    log(`cases capped to the first ${cases.length} of ${allCases.length} (--cases); a capped run is a calibration, not the measurement`);
  }
  const projectRoot = deps.projectRoot ?? process.cwd();
  const embeddings = deps.embeddings ?? embedderFromConfig(projectRoot);
  if (!(await embeddings.embed(["bench embedder probe"])).available) {
    log("embedder is unavailable; start the configured embedding endpoint and rerun");
    return 2;
  }
  const runRoot = deps.runRoot ?? mkdtempSync(join(tmpdir(), "mneme-bench-run-"));
  const modes: IngestMode[] = mode === "both" ? ["coexist", "supersede"] : [mode];
  const observationsByMode = new Map<IngestMode, CaseObservation[]>();
  let firstIndexPath: string | null = null;
  try {
    for (const ingestMode of modes) {
      const observations: CaseObservation[] = [];
      for (const [caseIndex, benchCase] of cases.entries()) {
        const corpusHome = join(runRoot, ingestMode, `case-${caseIndex}`);
        const ingested = await ingestCase(benchCase, ingestMode, { projectRoot, corpusHome, embeddings });
        firstIndexPath = firstIndexPath ?? ingested.indexPath;
        observations.push(await runCase(ingested, benchCase.questions, { embeddings }));
        log(`${ingestMode}: ${caseIndex + 1}/${cases.length} ${benchCase.id}`);
      }
      observationsByMode.set(ingestMode, observations);
    }
  } catch (error) {
    if (error instanceof IngestError || error instanceof BenchRunError) {
      log(error.message);
      return 1;
    }
    throw error;
  }
  const report = buildReport(
    {
      dataset,
      datasetSha256: createHash("sha256").update(datasetBytes).digest("hex"),
      budget: BENCH_RECALL_BUDGET,
      embedderModelConfigured: loadConfig(projectRoot).embedder.model,
      embedderModelIndexStamp: firstIndexPath === null ? null : readIndexStamp(firstIndexPath),
    },
    observationsByMode,
  );
  log("");
  log(renderReport(report));
  return 0;
}

function parseArguments(
  argv: string[],
): { dataset: BenchDatasetId; mode: ModeArgument; cases?: number } | undefined {
  let dataset: BenchDatasetId | undefined;
  let mode: ModeArgument = "coexist";
  let cases: number | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return undefined;
    if (flag === "--dataset" && (BENCH_DATASET_IDS as string[]).includes(value)) {
      dataset = value as BenchDatasetId;
    } else if (flag === "--mode" && (MODES as readonly string[]).includes(value)) {
      mode = value as ModeArgument;
    } else if (flag === "--cases" && /^[1-9]\d*$/.test(value)) {
      cases = Number(value);
    } else {
      return undefined;
    }
  }
  return dataset === undefined ? undefined : { dataset, mode, cases };
}

function embedderFromConfig(projectRoot: string): EmbeddingsClient {
  const config = loadConfig(projectRoot);
  return new HttpEmbeddingsClient(
    config.embedder.baseUrl,
    (url, init) => fetch(url, init),
    config.embedder.model,
    config.embedder.format,
  );
}

function readIndexStamp(indexPath: string): string | null {
  try {
    const database = new Database(indexPath, { readonly: true });
    try {
      const row = database.query("SELECT embedding_model FROM index_config LIMIT 1").get() as
        | { embedding_model: string }
        | null;
      return row?.embedding_model ?? null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
