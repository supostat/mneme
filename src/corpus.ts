import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRepo, initRepo } from "./git";

export class CorpusError extends Error {}

export interface CorpusManifest {
  path: string;
  created: string;
  format_version: number;
}

export interface Corpus {
  corpusDir: string;
  canonicalRoot: string;
  manifestPath: string;
  notesDir: string;
  stagingDir: string;
  archiveDir: string;
  eventsDir: string;
  indexPath: string;
}

export interface ResolveCorpusOptions {
  corpusHome?: string;
  clock?: () => Date;
}

const SUBDIRECTORIES = ["notes", "staging", "archive", "events"] as const;
const DIRECTORY_MODE = 0o700;
const CURRENT_FORMAT_VERSION = 2;
const MIGRATABLE_FORMAT_VERSIONS = new Set([1]);
const MANIFEST_FILENAME = "manifest.json";
const GITIGNORE_FILENAME = ".gitignore";
const GITIGNORE_CONTENT = "index.db\nevents/\nstaging/\n*.dedup.json\n";
const DEFAULT_CORPUS_DIRECTORY_NAME = ".mneme";

export function canonicalize(path: string): string {
  return realpathSync(path);
}

export function mungePath(canonicalRoot: string): string {
  return canonicalRoot.replaceAll("/", "-");
}

export async function resolveCorpus(
  projectRoot: string,
  options: ResolveCorpusOptions = {},
): Promise<Corpus> {
  const corpusHome = options.corpusHome ?? join(homedir(), DEFAULT_CORPUS_DIRECTORY_NAME);
  const clock = options.clock ?? (() => new Date());
  const canonicalRoot = canonicalize(projectRoot);
  const corpusDir = join(corpusHome, mungePath(canonicalRoot));
  const manifestPath = join(corpusDir, MANIFEST_FILENAME);
  const existedBefore = existsSync(corpusDir);

  makeDirectory(corpusHome);
  makeDirectory(corpusDir);
  ensureManifest(manifestPath, canonicalRoot, existedBefore, clock);
  for (const name of SUBDIRECTORIES) {
    makeDirectory(join(corpusDir, name));
  }
  await ensureGitRepository(corpusDir);
  ensureGitignore(corpusDir);

  return {
    corpusDir,
    canonicalRoot,
    manifestPath,
    notesDir: join(corpusDir, "notes"),
    stagingDir: join(corpusDir, "staging"),
    archiveDir: join(corpusDir, "archive"),
    eventsDir: join(corpusDir, "events"),
    indexPath: join(corpusDir, "index.db"),
  };
}

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(path, DIRECTORY_MODE);
}

function ensureManifest(
  manifestPath: string,
  canonicalRoot: string,
  existedBefore: boolean,
  clock: () => Date,
): void {
  if (existsSync(manifestPath)) {
    migrateManifestIfNeeded(manifestPath);
    const manifest = readManifest(manifestPath);
    if (manifest.path !== canonicalRoot) {
      throw new CorpusError(
        `corpus path collision: manifest belongs to ${manifest.path}, not ${canonicalRoot}`,
      );
    }
    return;
  }
  if (existedBefore) {
    throw new CorpusError(`corpus directory exists without a manifest: ${manifestPath}`);
  }
  const manifest: CorpusManifest = {
    path: canonicalRoot,
    created: clock().toISOString(),
    format_version: CURRENT_FORMAT_VERSION,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// Format 1 reserved a null-only `embedding_model` field; ADR D7 moved vector-model provenance to
// the disposable index, leaving that field a dead column. Format 2 drops it. An existing v1 manifest
// is rewritten in place; malformed records are left untouched so readManifest reports the exact fault.
function migrateManifestIfNeeded(manifestPath: string): void {
  const record = parseManifestFile(manifestPath);
  if (!MIGRATABLE_FORMAT_VERSIONS.has(record.format_version as number)) {
    return;
  }
  if (typeof record.path !== "string" || typeof record.created !== "string") {
    return;
  }
  const migrated: CorpusManifest = {
    path: record.path,
    created: record.created,
    format_version: CURRENT_FORMAT_VERSION,
  };
  writeFileSync(manifestPath, JSON.stringify(migrated, null, 2) + "\n");
}

export function readManifest(manifestPath: string): CorpusManifest {
  const record = parseManifestFile(manifestPath);
  if (typeof record.path !== "string") {
    throw new CorpusError(`manifest path is missing or not a string: ${manifestPath}`);
  }
  if (typeof record.created !== "string") {
    throw new CorpusError(`manifest created is missing or not a string: ${manifestPath}`);
  }
  if (record.format_version !== CURRENT_FORMAT_VERSION) {
    throw new CorpusError(
      `manifest has unknown format_version ${String(record.format_version)}: ${manifestPath}`,
    );
  }
  return {
    path: record.path,
    created: record.created,
    format_version: CURRENT_FORMAT_VERSION,
  };
}

function parseManifestFile(manifestPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new CorpusError(`manifest is unreadable or malformed: ${manifestPath}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CorpusError(`manifest is not an object: ${manifestPath}`);
  }
  return parsed as Record<string, unknown>;
}

async function ensureGitRepository(corpusDir: string): Promise<void> {
  if (!(await isRepo(corpusDir))) {
    await initRepo(corpusDir);
  }
}

function ensureGitignore(corpusDir: string): void {
  const gitignorePath = join(corpusDir, GITIGNORE_FILENAME);
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_CONTENT);
  }
}
