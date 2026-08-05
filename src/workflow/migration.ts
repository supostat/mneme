import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import type { Corpus } from "../corpus";
import { commitPaths } from "../corpus-git";
import { isPhaseId, serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";

// 12a phase-file persistence: serialize workflow phase documents into the CORPUS home
// (<corpusDir>/workflow/<spec-slug>/phase-<id>.md), never the project tree, so the server keeps its
// verified ~/.mneme-only write invariant. Every spec owns a slug subdirectory, so the phases of one
// task live together and identical phase ids from different specs never collide. Two phases:
// planMigration READS ONLY and classifies every target as create / identical / conflict;
// applyMigration executes a plan. Fail-closed (validate-all-then-write: serializePhaseDocument throws
// on any invalid document before a byte is written), atomic per file (temp + rename), idempotent (a
// byte-identical target skips, a divergent target is a conflict that refuses the whole apply — a
// human edit is never clobbered).
//
// Provenance: apply also archives the SOURCE spec byte-for-byte into <corpusDir>/specs/<slug>.md and
// records phases + archive in ONE corpus commit, so the corpus history answers "these phases were
// generated from THIS text". The archive deliberately sits outside the create/identical/conflict
// classification: a re-migrated spec OVERWRITES its archive, and the commit carries the spec's diff —
// that history is the point. A conflict refuses apply before any write, so neither phases nor archive
// land; a git failure after the writes leaves the files on disk and surfaces the error unswallowed.

export class MigrationError extends Error {}

export const WORKFLOW_PHASE_DIR = "workflow";
export const SPEC_ARCHIVE_DIR = "specs";
const TEMP_SUFFIX = ".mneme-tmp";

// A slug is a single safe path component: lowercase alphanumerics separated by single dashes, no
// leading/trailing dash. specSlug produces one; planMigration re-validates against this before
// deriving any path, so a hand-built slug carrying a slash or traversal fails closed.
const SPEC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Derive a spec's slug from its file name: drop the directory and extension, lowercase, map any
// character outside [a-z0-9-] to a dash, collapse dash runs, and trim edge dashes. A name that
// sanitizes to nothing (all punctuation) fails closed rather than yielding an unnamed directory.
export function specSlug(specPath: string): string {
  const slug = parse(specPath).name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length === 0) {
    throw new MigrationError(`spec file name yields an empty slug: ${specPath}`);
  }
  return slug;
}

export type WriteAction = "create" | "identical" | "conflict";

export interface PlannedWrite {
  phaseId: string;
  relativePath: string;
  absolutePath: string;
  action: WriteAction;
  bytes: number;
  content: string;
}

export interface MigrationPlan {
  workflowDir: string;
  specSlug: string;
  writes: PlannedWrite[];
}

export interface MigrationReport {
  created: string[];
  skipped: string[];
  commit: string;
}

// The spec file the phases were generated from, and the corpus whose git history records the apply.
export interface SpecArchive {
  specPath: string;
  corpus: Corpus;
}

export function planMigration(phases: PhaseDocument[], corpusDir: string, specSlug: string): MigrationPlan {
  assertSafeSlug(specSlug);
  const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR, specSlug);
  assertUniqueIds(phases);
  const writes = phases.map((phase) => planOne(phase, specSlug, workflowDir));
  return { workflowDir, specSlug, writes };
}

export async function applyMigration(plan: MigrationPlan, archive: SpecArchive): Promise<MigrationReport> {
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
  const archiveRelativePath = writeSpecArchive(plan, archive);
  const commit = await commitPaths(
    archive.corpus,
    [...plan.writes.map((write) => write.relativePath), archiveRelativePath],
    `Migrate ${plan.specSlug}: ${plan.writes.length} phases`,
  );
  return { created, skipped, commit };
}

function writeSpecArchive(plan: MigrationPlan, archive: SpecArchive): string {
  const content = readSpecBytes(archive.specPath);
  const specsDir = join(archive.corpus.corpusDir, SPEC_ARCHIVE_DIR);
  mkdirSync(specsDir, { recursive: true });
  const absolutePath = join(specsDir, `${plan.specSlug}.md`);
  const temporaryPath = absolutePath + TEMP_SUFFIX;
  try {
    writeFileSync(temporaryPath, content);
    renameSync(temporaryPath, absolutePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return join(SPEC_ARCHIVE_DIR, `${plan.specSlug}.md`);
}

// Bytes, never a decode/re-encode round-trip: the archive is provenance, so it must be the exact
// file the phases were generated from.
function readSpecBytes(specPath: string): Buffer {
  try {
    return readFileSync(specPath);
  } catch {
    throw new MigrationError(`cannot read the spec for archiving: ${specPath}`);
  }
}

function planOne(phase: PhaseDocument, specSlug: string, workflowDir: string): PlannedWrite {
  // serializePhaseDocument validates the whole document (including the id grammar) and throws on
  // any invalid field, so a bad phase fails closed here before any path is derived or written.
  const content = serializePhaseDocument(phase);
  if (!isPhaseId(phase.id)) {
    throw new MigrationError(`phase id is not a safe slug: ${phase.id}`);
  }
  const relativePath = join(WORKFLOW_PHASE_DIR, specSlug, `phase-${phase.id}.md`);
  const absolutePath = join(workflowDir, `phase-${phase.id}.md`);
  return {
    phaseId: phase.id,
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

function assertSafeSlug(specSlug: string): void {
  if (!SPEC_SLUG_PATTERN.test(specSlug)) {
    throw new MigrationError(`spec slug is not a safe path component: ${specSlug}`);
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
