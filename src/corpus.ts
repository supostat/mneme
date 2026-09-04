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
  name?: string;
}

export interface CorpusPaths {
  corpusDir: string;
  manifestPath: string;
  notesDir: string;
  stagingDir: string;
  archiveDir: string;
  eventsDir: string;
  indexPath: string;
}

export interface Corpus extends CorpusPaths {
  canonicalRoot: string;
}

export interface CorpusLocation {
  corpusHome: string;
  canonicalRoot: string;
  corpusDir: string;
}

export interface ResolveCorpusOptions {
  corpusHome?: string;
  corpusName?: string;
  clock?: () => Date;
}

const SUBDIRECTORIES = ["notes", "staging", "archive", "events"] as const;
const DIRECTORY_MODE = 0o700;
const CURRENT_FORMAT_VERSION = 3;
const MIGRATABLE_FORMAT_VERSIONS = new Set([1, 2]);
const MANIFEST_FILENAME = "manifest.json";
const GITIGNORE_FILENAME = ".gitignore";
// The index's WAL sidecars are listed because readers now recreate them on every open (see
// openReadOnlyDatabase), so they appear in every corpus, not only where a writer ran.
const GITIGNORE_ENTRIES = ["index.db", "index.db-wal", "index.db-shm", "events/", "staging/", "*.dedup.json"];
const GITIGNORE_CONTENT = `${GITIGNORE_ENTRIES.join("\n")}\n`;
const DEFAULT_CORPUS_DIRECTORY_NAME = ".mneme";

export function canonicalize(path: string): string {
  return realpathSync(path);
}

export function mungePath(canonicalRoot: string): string {
  return canonicalRoot.replaceAll("/", "-");
}

export function defaultCorpusHome(): string {
  return join(homedir(), DEFAULT_CORPUS_DIRECTORY_NAME);
}

// The pure, side-effect-free derivation of where a project's corpus lives. resolveCorpus builds on
// this and then creates/heals; a read-only caller (the doctor) uses it to locate the corpus WITHOUT
// creating anything, so a missing corpus is diagnosed rather than silently materialized.
// A configured corpusName replaces the munged directory, which is how two working copies of one
// project — two paths, two munged names — address a single shared corpus.
export function corpusDirFor(
  projectRoot: string,
  corpusHome?: string,
  corpusName?: string,
): CorpusLocation {
  const home = corpusHome ?? defaultCorpusHome();
  const canonicalRoot = canonicalize(projectRoot);
  const directoryName = corpusName ?? mungePath(canonicalRoot);
  return { corpusHome: home, canonicalRoot, corpusDir: join(home, directoryName) };
}

export function corpusPaths(corpusDir: string): CorpusPaths {
  return {
    corpusDir,
    manifestPath: join(corpusDir, MANIFEST_FILENAME),
    notesDir: join(corpusDir, "notes"),
    stagingDir: join(corpusDir, "staging"),
    archiveDir: join(corpusDir, "archive"),
    eventsDir: join(corpusDir, "events"),
    indexPath: join(corpusDir, "index.db"),
  };
}

export async function resolveCorpus(
  projectRoot: string,
  options: ResolveCorpusOptions = {},
): Promise<Corpus> {
  const clock = options.clock ?? (() => new Date());
  const { corpusHome, canonicalRoot, corpusDir } = corpusDirFor(
    projectRoot,
    options.corpusHome,
    options.corpusName,
  );
  const paths = corpusPaths(corpusDir);
  const existedBefore = existsSync(corpusDir);

  makeDirectory(corpusHome);
  makeDirectory(corpusDir);
  ensureManifest(paths.manifestPath, canonicalRoot, options.corpusName, existedBefore, clock);
  for (const name of SUBDIRECTORIES) {
    makeDirectory(join(corpusDir, name));
  }
  await ensureGitRepository(corpusDir);
  ensureGitignore(corpusDir);

  return { canonicalRoot, ...paths };
}

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(path, DIRECTORY_MODE);
}

function ensureManifest(
  manifestPath: string,
  canonicalRoot: string,
  corpusName: string | undefined,
  existedBefore: boolean,
  clock: () => Date,
): void {
  if (existsSync(manifestPath)) {
    migrateManifestIfNeeded(manifestPath);
    ensureManifestIdentity(manifestPath, canonicalRoot, corpusName);
    return;
  }
  if (existedBefore) {
    throw new CorpusError(`corpus directory exists without a manifest: ${manifestPath}`);
  }
  writeManifest(manifestPath, {
    path: canonicalRoot,
    created: clock().toISOString(),
    name: corpusName,
  });
}

// A NAMED corpus is identified by its NAME, never by the project path: it deliberately serves
// several working copies, so their canonical roots differ and the manifest records only whichever
// one created it. An UNNAMED corpus keeps the historical path guard, which is what catches a
// munging collision. A manifest without a name found under a requested name is adopted by stamping
// that name in — the path a corpus reached by a symlink takes when it moves to a real name.
function ensureManifestIdentity(
  manifestPath: string,
  canonicalRoot: string,
  corpusName: string | undefined,
): void {
  const manifest = readManifest(manifestPath);
  if (corpusName === undefined) {
    if (manifest.path !== canonicalRoot) {
      throw new CorpusError(
        `corpus path collision: manifest belongs to ${manifest.path}, not ${canonicalRoot}`,
      );
    }
    return;
  }
  if (manifest.name === undefined) {
    writeManifest(manifestPath, { path: manifest.path, created: manifest.created, name: corpusName });
    return;
  }
  if (manifest.name !== corpusName) {
    throw new CorpusError(
      `corpus name collision: manifest belongs to corpus "${manifest.name}", not "${corpusName}"`,
    );
  }
}

function writeManifest(
  manifestPath: string,
  fields: { path: string; created: string; name: string | undefined },
): void {
  const manifest: CorpusManifest = {
    path: fields.path,
    created: fields.created,
    format_version: CURRENT_FORMAT_VERSION,
    ...(fields.name === undefined ? {} : { name: fields.name }),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// Format 1 reserved a null-only `embedding_model` field; ADR D7 moved vector-model provenance to
// the disposable index, leaving that field a dead column. Format 2 drops it. Format 3 legitimizes
// the optional `name`, so an older engine meeting a v3 manifest fails on its unknown version instead
// of silently ignoring the name and addressing the wrong corpus. Every migratable version rewrites
// to the current one in a single pass; malformed records are left untouched so readManifest reports
// the exact fault. The name itself is not migrated in — ensureManifestIdentity stamps it.
function migrateManifestIfNeeded(manifestPath: string): void {
  const record = parseManifestFile(manifestPath);
  if (!MIGRATABLE_FORMAT_VERSIONS.has(record.format_version as number)) {
    return;
  }
  if (typeof record.path !== "string" || typeof record.created !== "string") {
    return;
  }
  writeManifest(manifestPath, { path: record.path, created: record.created, name: undefined });
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
  if (record.name !== undefined && typeof record.name !== "string") {
    throw new CorpusError(`manifest name is not a string: ${manifestPath}`);
  }
  return {
    path: record.path,
    created: record.created,
    format_version: CURRENT_FORMAT_VERSION,
    ...(record.name === undefined ? {} : { name: record.name }),
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

// A fresh corpus gets the whole list; an existing .gitignore is only ever APPENDED to with the
// entries it lacks. Lines a person added by hand stay untouched, and a file that already carries
// every entry is not rewritten — resolveCorpus runs on every tool call, so this must converge.
function ensureGitignore(corpusDir: string): void {
  const gitignorePath = join(corpusDir, GITIGNORE_FILENAME);
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_CONTENT);
    return;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) {
    return;
  }
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${existing}${separator}${missing.join("\n")}\n`);
}
