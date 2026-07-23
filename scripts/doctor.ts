#!/usr/bin/env bun
import { loadConfig } from "../src/config";
import type { ConfigEnvironment } from "../src/config";
import { corpusDirFor } from "../src/corpus";
import { runDoctor, renderDoctorReport } from "../src/doctor";
import type { DoctorReport } from "../src/doctor";
import { HttpEmbeddingsClient } from "../src/embeddings";
import type { FetchImplementation } from "../src/embeddings";

// Thin human-driven CLI over the read-only doctor library (mirrors scripts/replay.ts and
// scripts/migrate.ts): locate the current project's corpus WITHOUT creating it, run every wiring check,
// and print the human render on top of the structured report. Fail-closed exit codes: 0 = all ok,
// 1 = any component degraded or fail, 2 = usage error or fault.

const USAGE = "usage: bun scripts/doctor.ts";

export interface DoctorProjectOptions {
  fetchImplementation?: FetchImplementation;
  corpusHome?: string;
  environment?: ConfigEnvironment;
}

// The embedder is built from the project's .mneme.json (base_url, model, format), so the probe hits
// the endpoint the server itself would use — a configured openai endpoint is probed as openai, never
// the default Ollama. A broken config throws its named ConfigError into the caller's catch: config
// validity is a CLI precondition (exit 2), not a report component. loadConfig and corpusDirFor are
// both read-only, so the doctor still creates nothing.
export async function doctorForProject(
  projectRoot: string,
  options: DoctorProjectOptions = {},
): Promise<DoctorReport> {
  const config =
    options.environment === undefined ? loadConfig(projectRoot) : loadConfig(projectRoot, options.environment);
  const embedder = new HttpEmbeddingsClient(
    config.embedder.baseUrl,
    options.fetchImplementation ?? ((url, init) => fetch(url, init)),
    config.embedder.model,
    config.embedder.format,
  );
  const { corpusDir } = corpusDirFor(projectRoot, options.corpusHome);
  return runDoctor({ corpusDir, embedder });
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write(`unexpected argument: ${argv[0]}\n${USAGE}\n`);
    return 2;
  }
  try {
    const report = await doctorForProject(process.cwd());
    process.stdout.write(renderDoctorReport(report) + "\n");
    return report.overall === "ok" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
