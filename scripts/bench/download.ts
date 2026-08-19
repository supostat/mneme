#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DATASET_IDS } from "./normalize";
import type { BenchDatasetId } from "./normalize";

// Fetches the two benchmark datasets into scripts/bench/datasets/ (git-ignored).
// Fail-closed: a dataset that cannot be fetched or does not parse as JSON leaves
// nothing behind and exits 2 with the manual download instruction — the harness
// never runs on a missing or partial dataset.

const USAGE = "usage: bun scripts/bench/download.ts [locomo|longmemeval-s]";

export interface DatasetSource {
  file: string;
  url: string;
  manual: string;
}

export const DATASET_SOURCES: Record<BenchDatasetId, DatasetSource> = {
  locomo: {
    file: "locomo10.json",
    url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    manual: "clone https://github.com/snap-research/locomo and copy data/locomo10.json",
  },
  // The author deprecated the original longmemeval repo in favor of longmemeval-cleaned
  // (noisy history sessions interfering with answer correctness were removed); the harness
  // pins the cleaned S-variant. ~278 MB, LFS-backed.
  "longmemeval-s": {
    file: "longmemeval_s_cleaned.json",
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
    manual:
      "download longmemeval_s_cleaned.json from https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned " +
      "(or via the archive linked from https://github.com/xiaowu0162/LongMemEval)",
  },
};

export const DEFAULT_DATASETS_DIR = join(import.meta.dir, "datasets");

export type DownloadFetch = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

export interface DownloadDeps {
  fetchImplementation: DownloadFetch;
  datasetsDir: string;
  log: (line: string) => void;
}

export async function main(argv: string[], deps: DownloadDeps): Promise<number> {
  const first = argv[0];
  let selected: BenchDatasetId[];
  if (argv.length === 0) {
    selected = [...BENCH_DATASET_IDS];
  } else if (argv.length === 1 && isDatasetId(first)) {
    selected = [first];
  } else {
    deps.log(USAGE);
    return 2;
  }
  mkdirSync(deps.datasetsDir, { recursive: true });
  for (const dataset of selected) {
    const source = DATASET_SOURCES[dataset];
    const target = join(deps.datasetsDir, source.file);
    if (existsSync(target)) {
      deps.log(`${dataset}: already present at ${target}`);
      continue;
    }
    const body = await fetchJsonBody(deps.fetchImplementation, source.url);
    if (body === undefined) {
      deps.log(`${dataset}: download failed (${source.url})`);
      deps.log(`${dataset}: manual step — ${source.manual}; place the file at ${target}`);
      return 2;
    }
    writeFileSync(target, body);
    deps.log(`${dataset}: saved ${target}`);
  }
  return 0;
}

function isDatasetId(value: string | undefined): value is BenchDatasetId {
  return value !== undefined && (BENCH_DATASET_IDS as string[]).includes(value);
}

async function fetchJsonBody(fetchImplementation: DownloadFetch, url: string): Promise<string | undefined> {
  try {
    const response = await fetchImplementation(url);
    if (!response.ok) return undefined;
    const body = await response.text();
    JSON.parse(body);
    return body;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    fetchImplementation: (url) => fetch(url),
    datasetsDir: DEFAULT_DATASETS_DIR,
    log: console.log,
  });
}
