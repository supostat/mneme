import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "./corpus";
import { runGit } from "./git";
import type { GitResult } from "./git";
import type { EmbeddingsClient } from "./embeddings";
import type { EventWriter } from "./events";
import { serializeNote, parseNote, isNoteId } from "./note";
import type { NoteFrontmatter, NoteType } from "./note";
import { assertCleanNoteBody } from "./sanitize-body";
import { classifyCandidate } from "./dedup";
import { rebuild } from "./index-db";
import type { RebuildDeps } from "./index-db";
import { resolveAnchorLiveness } from "./anchor-liveness";
import type { StagedAnchor } from "./anchor-liveness";
import { sidecarFor, writeSidecar, readSidecar, removeSidecar, dedupSummary } from "./dedup-sidecar";
import type { StagedClassification, DedupSummary } from "./dedup-sidecar";
import { emitRemember, dedupPayload, dedupFromClassification, appendStagingResolve } from "./staging-resolve";

export class StagingError extends Error {}

export interface StagingDeps {
  corpus: Corpus;
  projectRoot: string;
  clock: () => Date;
  idFactory: () => string;
  embeddings: EmbeddingsClient;
  eventWriter: EventWriter;
}

export interface RememberInput {
  type: NoteType;
  body: string;
  anchors: string[];
  source: string;
}

export interface StagedRemember {
  outcome: "staged";
  noteId: string;
  type: NoteType;
  dedup: "add" | "supersede_offer";
  nearestId: string | null;
  similarity: number | null;
  degraded: boolean;
}

export type RememberResult =
  | StagedRemember
  | { outcome: "noop"; noteId: string; existingId: string; similarity: number };

export interface StagingEntry {
  id: string;
  type: NoteType;
  digest: string;
  anchors: StagedAnchor[];
  dedup: DedupSummary;
}

export type ResolveDecision = "accept" | "reject" | { supersede: string };

export type ResolveResult =
  | { outcome: "accepted"; noteId: string; commit: string }
  | { outcome: "rejected"; noteId: string }
  | { outcome: "superseded"; noteId: string; supersededId: string; commit: string; suggested: boolean };

const NOTE_EXTENSION = ".md";
const COMMIT_AUTHOR_ARGS = ["-c", "user.email=mneme@localhost", "-c", "user.name=mneme"];

function notePath(directory: string, id: string): string {
  return join(directory, `${id}${NOTE_EXTENSION}`);
}

export async function remember(deps: StagingDeps, input: RememberInput): Promise<RememberResult> {
  assertCleanNoteBody(input.body);
  const commit = await resolveHead(deps.projectRoot);
  const noteId = deps.idFactory();
  if (!isNoteId(noteId)) {
    throw new StagingError(`idFactory produced an invalid note id: ${noteId}`);
  }
  const classification = await classifyCandidate(deps.corpus.indexPath, deps.embeddings, input.body);
  if (classification.kind === "noop") {
    return dedupeNoop(deps, noteId, input, classification.neighborId, classification.similarity);
  }
  return stageNote(deps, noteId, commit, input, classification);
}

async function resolveHead(projectRoot: string): Promise<string> {
  const result = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new StagingError(
      "project has no resolvable HEAD - a repository without commits cannot anchor notes; " +
        `make the first commit, then retry: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function dedupeNoop(
  deps: StagingDeps,
  noteId: string,
  input: RememberInput,
  existingId: string,
  similarity: number,
): RememberResult {
  emitRemember(deps, noteId, input, dedupPayload("noop", existingId, similarity, false));
  return { outcome: "noop", noteId, existingId, similarity };
}

function stageNote(deps: StagingDeps, noteId: string, commit: string, input: RememberInput, classification: StagedClassification): StagedRemember {
  const frontmatter: NoteFrontmatter = {
    id: noteId,
    type: input.type,
    anchors: input.anchors,
    commit,
    created: deps.clock().toISOString(),
  };
  const serialized = serializeNote({ frontmatter, body: input.body });
  const sidecar = sidecarFor(classification);
  writeFileSync(notePath(deps.corpus.stagingDir, noteId), serialized);
  writeSidecar(deps.corpus, noteId, sidecar);
  emitRemember(deps, noteId, input, dedupFromClassification(classification));
  return {
    outcome: "staged",
    noteId,
    type: input.type,
    dedup: sidecar.dedup,
    nearestId: sidecar.nearest_id,
    similarity: sidecar.similarity,
    degraded: sidecar.degraded,
  };
}

// The cheap read the workflow boundary needs: how many notes await review, with no liveness
// resolution, no sidecar reads and no staging_listed event — listing stays the reviewed act.
export function countStagedNotes(corpus: Corpus): number {
  return readdirSync(corpus.stagingDir).filter((name) => name.endsWith(NOTE_EXTENSION)).length;
}

export async function stagingList(deps: StagingDeps): Promise<StagingEntry[]> {
  const files = readdirSync(deps.corpus.stagingDir)
    .filter((name) => name.endsWith(NOTE_EXTENSION))
    .sort();
  const entries: StagingEntry[] = [];
  for (const file of files) {
    entries.push(await stagingEntry(deps.corpus, deps.projectRoot, file));
  }
  deps.eventWriter.append({
    type: "staging_listed",
    count: entries.length,
    liveness: entries.map((entry) => ({ id: entry.id, anchors: entry.anchors })),
  });
  return entries;
}

async function stagingEntry(corpus: Corpus, projectRoot: string, file: string): Promise<StagingEntry> {
  const id = file.slice(0, -NOTE_EXTENSION.length);
  const note = parseNote(readFileSync(join(corpus.stagingDir, file), "utf8"));
  return {
    id,
    type: note.frontmatter.type,
    digest: firstLine(note.body),
    anchors: await resolveAnchorLiveness(projectRoot, note.frontmatter.anchors),
    dedup: dedupSummary(readSidecar(corpus, id)),
  };
}

function firstLine(body: string): string {
  const newlineIndex = body.indexOf("\n");
  return newlineIndex === -1 ? body : body.slice(0, newlineIndex);
}

export async function stagingResolve(deps: StagingDeps, id: string, decision: ResolveDecision): Promise<ResolveResult> {
  if (!isNoteId(id)) {
    throw new StagingError(`invalid staged note id: ${id}`);
  }
  if (decision === "reject") {
    return rejectNote(deps, id);
  }
  if (decision === "accept") {
    return acceptNote(deps, id);
  }
  return supersedeNote(deps, id, decision.supersede);
}

async function acceptNote(deps: StagingDeps, id: string): Promise<ResolveResult> {
  moveStagedToNotes(deps.corpus, id, (frontmatter) => frontmatter);
  const commit = await commitResolved(deps.corpus, notesRelPath(id), `Add note ${shortId(id)}`);
  appendStagingResolve(deps, id, "accept", { commit, superseded_id: null, suggested: null });
  removeSidecar(deps.corpus, id);
  await rebuild(rebuildDeps(deps));
  return { outcome: "accepted", noteId: id, commit };
}

async function supersedeNote(deps: StagingDeps, id: string, target: string): Promise<ResolveResult> {
  validateSupersedeTarget(deps.corpus, id, target);
  const suggested = readSidecar(deps.corpus, id)?.nearest_id === target;
  moveStagedToNotes(deps.corpus, id, (frontmatter) => ({ ...frontmatter, supersedes: target }));
  const commit = await commitResolved(deps.corpus, notesRelPath(id), `Supersede ${shortId(target)} with ${shortId(id)}`);
  appendStagingResolve(deps, id, "supersede", { commit, superseded_id: target, suggested });
  removeSidecar(deps.corpus, id);
  await rebuild(rebuildDeps(deps));
  return { outcome: "superseded", noteId: id, supersededId: target, commit, suggested };
}

function validateSupersedeTarget(corpus: Corpus, id: string, target: string): void {
  if (!isNoteId(target)) {
    throw new StagingError(`supersede target is not a valid note id: ${target}`);
  }
  if (target === id) {
    throw new StagingError(`a note cannot supersede itself: ${id}`);
  }
  if (!existsSync(notePath(corpus.notesDir, target))) {
    throw new StagingError(`supersede target does not exist in notes: ${target}`);
  }
}

function rejectNote(deps: StagingDeps, id: string): ResolveResult {
  const stagingPath = notePath(deps.corpus.stagingDir, id);
  if (!existsSync(stagingPath)) {
    if (existsSync(notePath(deps.corpus.archiveDir, id))) {
      removeSidecar(deps.corpus, id);
      return { outcome: "rejected", noteId: id };
    }
    throw new StagingError(`no staged note to reject: ${id}`);
  }
  renameSync(stagingPath, notePath(deps.corpus.archiveDir, id));
  removeSidecar(deps.corpus, id);
  appendStagingResolve(deps, id, "reject", { commit: null, superseded_id: null, suggested: null });
  return { outcome: "rejected", noteId: id };
}

function moveStagedToNotes(corpus: Corpus, id: string, transform: (frontmatter: NoteFrontmatter) => NoteFrontmatter): void {
  const stagingPath = notePath(corpus.stagingDir, id);
  if (!existsSync(stagingPath)) {
    if (existsSync(notePath(corpus.notesDir, id))) return;
    throw new StagingError(`no staged note to resolve: ${id}`);
  }
  const note = parseNote(readFileSync(stagingPath, "utf8"));
  const serialized = serializeNote({ frontmatter: transform(note.frontmatter), body: note.body });
  writeFileSync(notePath(corpus.notesDir, id), serialized);
  rmSync(stagingPath, { force: true });
}

async function commitResolved(corpus: Corpus, relativePath: string, subject: string): Promise<string> {
  await runGitOrThrow(corpus.corpusDir, ["add"], [relativePath]);
  const staged = await runGit(corpus.corpusDir, ["diff", "--cached", "--quiet"], [relativePath]);
  if (staged.exitCode !== 0) {
    await runGitOrThrow(corpus.corpusDir, [...COMMIT_AUTHOR_ARGS, "commit", "-q", "-m", subject]);
  }
  const head = await runGitOrThrow(corpus.corpusDir, ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}

async function runGitOrThrow(repoDir: string, args: string[], pathArgs: string[] = []): Promise<GitResult> {
  const result = await runGit(repoDir, args, pathArgs);
  if (result.exitCode !== 0) {
    throw new StagingError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function rebuildDeps(deps: StagingDeps): RebuildDeps {
  return {
    indexPath: deps.corpus.indexPath,
    notesDir: deps.corpus.notesDir,
    projectRoot: deps.projectRoot,
    embeddings: deps.embeddings,
    eventWriter: deps.eventWriter,
    clock: deps.clock,
  };
}

function notesRelPath(id: string): string {
  return `notes/${id}${NOTE_EXTENSION}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
