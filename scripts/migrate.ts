#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolveCorpus } from "../src/corpus";
import { phaseDocumentsFromSpec } from "../src/workflow/from-spec";
import { applyMigration, planMigration, specSlug } from "../src/workflow/migration";
import {
  createdAbsolutePaths,
  renderMigrationManifest,
  renderPathList,
  renderRunCommand,
} from "../src/workflow/migration-rendering";

// Thin human-driven CLI over the 12a persistence library (mirrors scripts/replay.ts): read a spec,
// generate phase documents via from-spec, resolve the current project's corpus, and plan the
// phase-file writes into <corpusDir>/workflow/<spec-slug>/. Dry-run by default (prints the manifest,
// writes nothing); --apply performs the writes. Exit codes: 0 clean, 1 conflicts, 2 fault.

const USAGE = "usage: bun scripts/migrate.ts <spec-path> [--apply]";

export interface MigrateArgs {
  specPath: string;
  apply: boolean;
}

export function parseMigrateArgs(argv: string[]): MigrateArgs {
  let specPath: string | undefined;
  let apply = false;
  for (const token of argv) {
    if (token === "--apply") {
      apply = true;
    } else if (token.startsWith("--")) {
      throw usageError(`unknown flag: ${token}`);
    } else if (specPath === undefined) {
      specPath = token;
    } else {
      throw usageError(`unexpected argument: ${token}`);
    }
  }
  if (specPath === undefined) throw usageError("missing <spec-path>");
  return { specPath, apply };
}

function usageError(detail: string): Error {
  return new Error(`${detail}\n${USAGE}`);
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

export async function main(argv: string[]): Promise<number> {
  let args: MigrateArgs;
  try {
    args = parseMigrateArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  try {
    const phases = phaseDocumentsFromSpec(readFileSync(args.specPath, "utf8"));
    const corpus = await resolveCorpus(process.cwd());
    const plan = planMigration(phases, corpus.corpusDir, specSlug(args.specPath));
    const conflicts = plan.writes.filter((write) => write.action === "conflict").length;
    const absolutePaths = plan.writes.map((write) => write.absolutePath);
    if (!args.apply) {
      writeLine(renderMigrationManifest(plan));
      writeLine(renderPathList("Full paths (dry-run — nothing written yet):", absolutePaths));
      if (conflicts === 0) {
        writeLine(renderRunCommand(plan));
      }
      return conflicts > 0 ? 1 : 0;
    }
    if (conflicts > 0) {
      writeLine(renderMigrationManifest(plan));
      process.stderr.write(`refusing to apply: ${conflicts} conflict(s)\n`);
      return 1;
    }
    const report = applyMigration(plan);
    writeLine(`wrote ${report.created.length}, skipped ${report.skipped.length} in ${plan.workflowDir}`);
    const createdPaths = createdAbsolutePaths(plan, report);
    if (createdPaths.length > 0) {
      writeLine(renderPathList("Created:", createdPaths));
    }
    writeLine(renderRunCommand(plan));
    return 0;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
