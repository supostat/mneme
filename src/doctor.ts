import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { corpusPaths, readManifest, mungePath } from "./corpus";
import type { CorpusManifest, CorpusPaths } from "./corpus";
import { scanEventLog } from "./events";
import { inspectIndex } from "./index-inspect";
import type { IndexInspection } from "./index-inspect";
import { runGit } from "./git";
import type { GitResult } from "./git";
import { EMBEDDING_DIMENSION } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";

// A read-only diagnostic of mneme's wiring. runDoctor probes each component, catches its own failures,
// and returns a STRUCTURED machine report (the source of truth); renderDoctorReport is a pure human
// view on top. The doctor DIAGNOSES only: no rebuild, no git write, no staging, no corpus creation.

export type DoctorStatus = "ok" | "degraded" | "fail";

export interface DoctorComponentReport {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  components: DoctorComponentReport[];
  overall: DoctorStatus;
}

export type GitRunner = (repoDir: string, args: string[]) => Promise<GitResult>;

export interface DoctorDeps {
  corpusDir: string;
  embedder: EmbeddingsClient;
  git?: GitRunner;
  expectedDimension?: number;
  probeText?: string;
}

interface CheckOutcome {
  status: DoctorStatus;
  detail: string;
}

type IndexProbe = { ok: true; inspection: IndexInspection } | { ok: false; error: string };

const DOCTOR_PROBE_TEXT = "mneme doctor embedding probe";
const SECURE_DIRECTORY_MODE = 0o700;
const STATUS_SEVERITY: Record<DoctorStatus, number> = { ok: 0, degraded: 1, fail: 2 };

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const paths = corpusPaths(deps.corpusDir);
  const indexProbe = probeIndex(paths.indexPath);
  const gitRunner = deps.git ?? runGit;
  const expectedDimension = deps.expectedDimension ?? EMBEDDING_DIMENSION;
  const probeText = deps.probeText ?? DOCTOR_PROBE_TEXT;
  const components = await Promise.all([
    runGuarded("corpus_root", () => checkCorpusRoot(deps.corpusDir)),
    runGuarded("manifest", () => checkManifest(paths)),
    runGuarded("note_store", () => checkNoteStore(paths)),
    runGuarded("event_log", () => checkEventLog(paths.eventsDir)),
    runGuarded("index", () => checkIndex(indexProbe)),
    runGuarded("embeddings", () => checkEmbeddings(deps.embedder, indexProbe, expectedDimension, probeText)),
    runGuarded("git", () => checkGit(gitRunner, deps.corpusDir)),
  ]);
  return { components, overall: worstStatus(components) };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.components.map(
    (component) => `${statusLabel(component.status)} ${component.name}: ${component.detail}`,
  );
  lines.push(`${statusLabel(report.overall)} overall`);
  return lines.join("\n");
}

function statusLabel(status: DoctorStatus): string {
  return `[${status}]`.padEnd(11);
}

// The isolation boundary: a check that throws is reported as fail for THAT component with the error in
// detail, so one broken component never aborts the others. Checks that WANT degraded (the disposable
// index) return it explicitly; only an unexpected throw becomes a crash-fail here.
async function runGuarded(
  name: string,
  run: () => Promise<CheckOutcome> | CheckOutcome,
): Promise<DoctorComponentReport> {
  try {
    const outcome = await run();
    return { name, status: outcome.status, detail: outcome.detail };
  } catch (error) {
    return { name, status: "fail", detail: `check crashed: ${errorMessage(error)}` };
  }
}

// One read-only open of the index cache, shared by the index and embeddings checks. Computed
// defensively before any check runs so a corrupt db surfaces as data, never an abort.
function probeIndex(indexPath: string): IndexProbe {
  try {
    return { ok: true, inspection: inspectIndex(indexPath) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function checkCorpusRoot(corpusDir: string): CheckOutcome {
  if (!existsSync(corpusDir)) {
    return { status: "fail", detail: `corpus directory is missing: ${corpusDir}` };
  }
  const stats = statSync(corpusDir);
  if (!stats.isDirectory()) {
    return { status: "fail", detail: `corpus path is not a directory: ${corpusDir}` };
  }
  const mode = stats.mode & 0o777;
  if (mode !== SECURE_DIRECTORY_MODE) {
    return { status: "degraded", detail: `corpus directory mode is 0${mode.toString(8)}, expected 0700` };
  }
  return { status: "ok", detail: "present with secure 0700 permissions" };
}

function checkManifest(paths: CorpusPaths): CheckOutcome {
  if (!existsSync(paths.manifestPath)) {
    return { status: "fail", detail: "manifest.json is missing" };
  }
  let manifest: CorpusManifest;
  try {
    manifest = readManifest(paths.manifestPath);
  } catch (error) {
    return { status: "fail", detail: errorMessage(error) };
  }
  const expected = basename(paths.corpusDir);
  if (mungePath(manifest.path) !== expected) {
    return {
      status: "fail",
      detail: `manifest path ${manifest.path} does not match corpus directory ${expected} (munging collision)`,
    };
  }
  return { status: "ok", detail: `format v${manifest.format_version} for ${manifest.path}` };
}

function checkNoteStore(paths: CorpusPaths): CheckOutcome {
  if (!isDirectory(paths.notesDir)) {
    return { status: "fail", detail: "notes/ directory is missing" };
  }
  const auxiliary: Array<[string, string]> = [
    ["staging", paths.stagingDir],
    ["archive", paths.archiveDir],
  ];
  const missing = auxiliary.filter(([, dir]) => !isDirectory(dir)).map(([name]) => name);
  if (missing.length > 0) {
    return { status: "degraded", detail: `auxiliary note directories missing: ${missing.join(", ")}` };
  }
  return { status: "ok", detail: "notes/, staging/ and archive/ present" };
}

function checkEventLog(eventsDir: string): CheckOutcome {
  if (!isDirectory(eventsDir)) {
    return { status: "degraded", detail: "events/ directory is absent (recreated on next resolve)" };
  }
  const scan = scanEventLog(eventsDir);
  if (scan.corruptLineCount > 0) {
    return {
      status: "degraded",
      detail: `${scan.corruptLineCount} corrupt event line(s) skipped across ${scan.fileCount} file(s)`,
    };
  }
  return { status: "ok", detail: `${scan.eventCount} event(s) across ${scan.fileCount} file(s)` };
}

// The index is a DISPOSABLE cache (delete -> rebuild -> identical), so every index fault is reduced,
// not fatal: absent, incomplete, unreadable, or vector-less all degrade rather than fail.
function checkIndex(probe: IndexProbe): CheckOutcome {
  if (!probe.ok) {
    return { status: "degraded", detail: `index is unreadable but rebuildable: ${probe.error}` };
  }
  const inspection = probe.inspection;
  if (!inspection.present) {
    return { status: "degraded", detail: "index.db is absent (rebuilt on next recall)" };
  }
  if (!inspection.hasRequiredTables) {
    return {
      status: "degraded",
      detail: `index schema is incomplete (rebuild required); tables: ${inspection.tables.join(", ")}`,
    };
  }
  if (inspection.noteCount > 0 && inspection.vectorCount === 0) {
    return {
      status: "degraded",
      detail: `index holds ${inspection.noteCount} note(s) but no stored vectors (recall runs FTS-only until rebuild)`,
    };
  }
  return { status: "ok", detail: `${inspection.noteCount} note(s), ${inspection.vectorCount} vector(s)` };
}

// Ollama unreachable is fatal to recall's semantic channel -> fail. A reachable embedder whose output
// dimension differs from the stored vectors would silently break cosine scoring -> degraded, named.
async function checkEmbeddings(
  embedder: EmbeddingsClient,
  probe: IndexProbe,
  expectedDimension: number,
  probeText: string,
): Promise<CheckOutcome> {
  const expected =
    probe.ok && probe.inspection.storedDimension !== null
      ? probe.inspection.storedDimension
      : expectedDimension;
  const result = await embedder.embed([probeText]);
  if (!result.available) {
    return { status: "fail", detail: "embedder is unavailable (endpoint unreachable at probe)" };
  }
  const vector = result.embeddings[0];
  if (vector === undefined) {
    return { status: "degraded", detail: "embedder is reachable but returned no probe vector" };
  }
  if (vector.length !== expected) {
    return {
      status: "degraded",
      detail: `embedder dimension ${vector.length} does not match index dimension ${expected}`,
    };
  }
  return { status: "ok", detail: `reachable, dimension ${vector.length}` };
}

async function checkGit(gitRunner: GitRunner, corpusDir: string): Promise<CheckOutcome> {
  const result = await gitRunner(corpusDir, ["rev-parse", "--git-dir"]);
  if (result.exitCode !== 0) {
    return { status: "fail", detail: `corpus is not a git repository: ${result.stderr.trim()}` };
  }
  return { status: "ok", detail: "corpus is a git repository" };
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function worstStatus(components: DoctorComponentReport[]): DoctorStatus {
  let worst: DoctorStatus = "ok";
  for (const component of components) {
    if (STATUS_SEVERITY[component.status] > STATUS_SEVERITY[worst]) {
      worst = component.status;
    }
  }
  return worst;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
