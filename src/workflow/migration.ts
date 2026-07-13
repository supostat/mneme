import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPhaseId, serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";

// 12a phase-file persistence: serialize workflow phase documents into the CORPUS home
// (<corpusDir>/workflow/phase-<id>.md), never the project tree, so the server keeps its verified
// ~/.mneme-only write invariant. Two phases: planMigration READS ONLY and classifies every target
// as create / identical / conflict; applyMigration executes a plan. Fail-closed
// (validate-all-then-write: serializePhaseDocument throws on any invalid document before a byte is
// written), atomic per file (temp + rename), idempotent (a byte-identical target skips, a divergent
// target is a conflict that refuses the whole apply — a human edit is never clobbered).

export class MigrationError extends Error {}

export const WORKFLOW_PHASE_DIR = "workflow";
const TEMP_SUFFIX = ".mneme-tmp";

export type WriteAction = "create" | "identical" | "conflict";

export interface PlannedWrite {
  relativePath: string;
  absolutePath: string;
  action: WriteAction;
  bytes: number;
  content: string;
}

export interface MigrationPlan {
  workflowDir: string;
  writes: PlannedWrite[];
}

export interface MigrationReport {
  created: string[];
  skipped: string[];
}

export function planMigration(phases: PhaseDocument[], corpusDir: string): MigrationPlan {
  const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR);
  assertUniqueIds(phases);
  const writes = phases.map((phase) => planOne(phase, workflowDir));
  return { workflowDir, writes };
}

export function applyMigration(plan: MigrationPlan): MigrationReport {
  requireNoConflicts(plan.writes);
  // TOCTOU narrowing: the target state may have changed since planning, so re-classify against the
  // current disk and refuse if anything now diverges — before writing a single byte.
  const fresh = plan.writes.map((write) => ({ ...write, action: classifyAction(write.absolutePath, write.content) }));
  requireNoConflicts(fresh);
  mkdirSync(plan.workflowDir, { recursive: true });
  const temporaryPaths: string[] = [];
  const created: string[] = [];
  const skipped: string[] = [];
  try {
    for (const write of fresh) {
      if (write.action === "identical") {
        skipped.push(write.relativePath);
        continue;
      }
      const temporaryPath = write.absolutePath + TEMP_SUFFIX;
      temporaryPaths.push(temporaryPath);
      writeFileSync(temporaryPath, write.content);
      renameSync(temporaryPath, write.absolutePath);
      created.push(write.relativePath);
    }
  } finally {
    for (const temporaryPath of temporaryPaths) {
      rmSync(temporaryPath, { force: true });
    }
  }
  return { created, skipped };
}

function planOne(phase: PhaseDocument, workflowDir: string): PlannedWrite {
  // serializePhaseDocument validates the whole document (including the id grammar) and throws on
  // any invalid field, so a bad phase fails closed here before any path is derived or written.
  const content = serializePhaseDocument(phase);
  if (!isPhaseId(phase.id)) {
    throw new MigrationError(`phase id is not a safe slug: ${phase.id}`);
  }
  const relativePath = join(WORKFLOW_PHASE_DIR, `phase-${phase.id}.md`);
  const absolutePath = join(workflowDir, `phase-${phase.id}.md`);
  return {
    relativePath,
    absolutePath,
    action: classifyAction(absolutePath, content),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
  };
}

function classifyAction(absolutePath: string, content: string): WriteAction {
  if (!existsSync(absolutePath)) {
    return "create";
  }
  return readFileSync(absolutePath, "utf8") === content ? "identical" : "conflict";
}

function requireNoConflicts(writes: PlannedWrite[]): void {
  const conflicts = writes.filter((write) => write.action === "conflict");
  if (conflicts.length > 0) {
    throw new MigrationError(
      `refusing to apply: ${conflicts.length} target(s) diverge from an existing file: ${conflicts
        .map((write) => write.relativePath)
        .join(", ")}`,
    );
  }
}

function assertUniqueIds(phases: PhaseDocument[]): void {
  const seen = new Set<string>();
  for (const phase of phases) {
    if (seen.has(phase.id)) {
      throw new MigrationError(`duplicate phase id: ${phase.id}`);
    }
    seen.add(phase.id);
  }
}
