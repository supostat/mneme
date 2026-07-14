#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolveCorpus } from "../src/corpus";
import { phaseDocumentsFromSpec } from "../src/workflow/from-spec";
import { applyMigration, planMigration } from "../src/workflow/migration";
import type { MigrationPlan, MigrationReport } from "../src/workflow/migration";

// Thin human-driven CLI over the 12a persistence library (mirrors scripts/replay.ts): read a spec,
// generate phase documents via from-spec, resolve the current project's corpus, and plan the
// phase-file writes into <corpusDir>/workflow/. Dry-run by default (prints the manifest, writes
// nothing); --apply performs the writes. Exit codes: 0 clean, 1 conflicts, 2 fault.

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

function renderManifest(plan: MigrationPlan): string {
  const lines = [`Phase-file plan -> ${plan.workflowDir}`];
  for (const write of plan.writes) {
    lines.push(`  ${write.action.padEnd(9)} ${write.relativePath} (${write.bytes} bytes)`);
  }
  return lines.join("\n") + "\n";
}

function renderPathList(header: string, paths: string[]): string {
  return [header, ...paths.map((path) => `  ${path}`)].join("\n") + "\n";
}

// The convenience launch line: /mneme:dev takes ONE phase file, so a single-phase plan gets a
// ready-to-paste command; a multi-phase graph gets its dependency-root (plan order = listing order,
// deps chain sequentially from from-spec) as the entry point.
function renderRunCommand(plan: MigrationPlan): string {
  const paths = plan.writes.map((write) => write.absolutePath);
  const [entry] = paths;
  if (entry === undefined) {
    return "";
  }
  if (paths.length === 1) {
    return `Run it with:\n  /mneme:dev ${entry}\n`;
  }
  return `Entry phase (dependency root) — run with:\n  /mneme:dev ${entry}\n`;
}

function createdAbsolutePaths(plan: MigrationPlan, report: MigrationReport): string[] {
  const absoluteByRelative = new Map(plan.writes.map((write) => [write.relativePath, write.absolutePath]));
  return report.created
    .map((relativePath) => absoluteByRelative.get(relativePath))
    .filter((path): path is string => path !== undefined);
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
    const plan = planMigration(phases, corpus.corpusDir);
    const conflicts = plan.writes.filter((write) => write.action === "conflict").length;
    const absolutePaths = plan.writes.map((write) => write.absolutePath);
    if (!args.apply) {
      process.stdout.write(renderManifest(plan));
      process.stdout.write(renderPathList("Full paths (dry-run — nothing written yet):", absolutePaths));
      if (conflicts === 0) {
        process.stdout.write(renderRunCommand(plan));
      }
      return conflicts > 0 ? 1 : 0;
    }
    if (conflicts > 0) {
      process.stdout.write(renderManifest(plan));
      process.stderr.write(`refusing to apply: ${conflicts} conflict(s)\n`);
      return 1;
    }
    const report = applyMigration(plan);
    process.stdout.write(`wrote ${report.created.length}, skipped ${report.skipped.length} in ${plan.workflowDir}\n`);
    const createdPaths = createdAbsolutePaths(plan, report);
    if (createdPaths.length > 0) {
      process.stdout.write(renderPathList("Created:", createdPaths));
    }
    process.stdout.write(renderRunCommand(plan));
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
