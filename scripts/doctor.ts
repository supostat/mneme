#!/usr/bin/env bun
import { corpusDirFor } from "../src/corpus";
import { runDoctor, renderDoctorReport } from "../src/doctor";
import { HttpEmbeddingsClient } from "../src/embeddings";

// Thin human-driven CLI over the read-only doctor library (mirrors scripts/replay.ts and
// scripts/migrate.ts): locate the current project's corpus WITHOUT creating it, run every wiring check,
// and print the human render on top of the structured report. Fail-closed exit codes: 0 = all ok,
// 1 = any component degraded or fail, 2 = usage error or fault.

const USAGE = "usage: bun scripts/doctor.ts";

export async function main(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write(`unexpected argument: ${argv[0]}\n${USAGE}\n`);
    return 2;
  }
  try {
    const { corpusDir } = corpusDirFor(process.cwd());
    const report = await runDoctor({ corpusDir, embedder: new HttpEmbeddingsClient() });
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
