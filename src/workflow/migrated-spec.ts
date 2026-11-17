import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knowledgeOfSpec } from "./from-spec";
import { SPEC_ARCHIVE_DIR, WORKFLOW_PHASE_DIR, isSpecSlug } from "./migration";
import { PhaseDocumentValidationError, parsePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";
import { PhaseGenerationError } from "./phase-generation";

// Read side of migration: what `workflow_migrate` wrote into the corpus, read back through the
// engine's own corpus directory, so no caller has to know where a corpus lives or how it is named.
// A migrated spec is a <corpusDir>/workflow/<slug>/ folder holding at least one phase-*.md; its
// Knowledge comes from the byte-for-byte archive <corpusDir>/specs/<slug>.md through the very rule
// from-spec applied when the phases were generated. Every refusal names the file it is about and is
// raised before anything downstream is written.

export class MigratedSpecError extends Error {}

export interface MigratedSpecSummary {
  slug: string;
  phaseCount: number;
}

// knowledge is null when the archive is absent (a spec migrated before archives existed, or a
// removed file) — never an empty list, which is an archive whose Knowledge section is empty.
export interface MigratedSpec {
  slug: string;
  documents: PhaseDocument[];
  knowledge: string[] | null;
}

const PHASE_FILE_PATTERN = /^phase-.+\.md$/;

export function migratedSpecSlugs(corpusDir: string): MigratedSpecSummary[] {
  const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR);
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSpecSlug(entry.name))
    .map((entry) => ({ slug: entry.name, phaseCount: phaseFileNames(join(workflowDir, entry.name)).length }))
    .filter((summary) => summary.phaseCount > 0)
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

export function readMigratedSpec(corpusDir: string, slug: string): MigratedSpec {
  if (!isSpecSlug(slug)) {
    throw new MigratedSpecError(
      `spec slug "${slug}" is not a slug: lowercase letters and digits separated by single dashes`,
    );
  }
  const specDir = join(corpusDir, WORKFLOW_PHASE_DIR, slug);
  const names = phaseFileNames(specDir);
  if (names.length === 0) {
    throw new MigratedSpecError(unknownSlugMessage(corpusDir, slug));
  }
  return {
    slug,
    documents: names.map((name) => readPhaseFile(specDir, slug, name)),
    knowledge: readArchiveKnowledge(corpusDir, slug),
  };
}

function unknownSlugMessage(corpusDir: string, slug: string): string {
  const migrated = migratedSpecSlugs(corpusDir).map((summary) => summary.slug);
  const tail = migrated.length === 0 ? "no spec is migrated" : `migrated specs: ${migrated.join(", ")}`;
  return `no migrated spec "${slug}" in this corpus; ${tail}`;
}

function phaseFileNames(specDir: string): string[] {
  if (!existsSync(specDir)) return [];
  return readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PHASE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// Only a parse failure is renamed after its file; an unreadable file is a filesystem error and keeps
// its own message.
function readPhaseFile(specDir: string, slug: string, name: string): PhaseDocument {
  const text = readFileSync(join(specDir, name), "utf8");
  try {
    return parsePhaseDocument(text);
  } catch (error) {
    if (!(error instanceof PhaseDocumentValidationError)) throw error;
    throw new MigratedSpecError(`phase file ${join(WORKFLOW_PHASE_DIR, slug, name)} does not parse: ${error.message}`);
  }
}

function readArchiveKnowledge(corpusDir: string, slug: string): string[] | null {
  const archivePath = join(corpusDir, SPEC_ARCHIVE_DIR, `${slug}.md`);
  if (!existsSync(archivePath)) return null;
  const text = readFileSync(archivePath, "utf8");
  try {
    return knowledgeOfSpec(text);
  } catch (error) {
    if (!(error instanceof PhaseGenerationError)) throw error;
    throw new MigratedSpecError(
      `spec archive ${join(SPEC_ARCHIVE_DIR, `${slug}.md`)} has a Knowledge section that does not parse: ${error.message}`,
    );
  }
}
