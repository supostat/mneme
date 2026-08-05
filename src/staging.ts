import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MnemeConfig } from "./config";
import type { Corpus } from "./corpus";
import { commitPaths } from "./corpus-git";
import { runGit } from "./git";
import type { EmbeddingsClient } from "./embeddings";
import type { EventWriter } from "./events";
import { serializeNote, parseNote, isNoteId } from "./note";
import type { NoteFrontmatter, NoteType } from "./note";
import { assertCleanNoteBody } from "./sanitize-body";
import { classifyCandidate } from "./dedup";
import { rebuild } from "./index-db";
import type { RebuildDeps } from "./index-db";
import { createLivenessContext, pathEverExisted, resolveAnchorLiveness } from "./anchor-liveness";
import type { LivenessContext, StagedAnchor } from "./anchor-liveness";
import { sidecarFor, writeSidecar, readSidecar, removeSidecar, dedupSummary } from "./dedup-sidecar";
import type { StagedClassification, DedupSummary } from "./dedup-sidecar";
import { emitRemember, dedupPayload, dedupFromClassification, appendReanchorResolved, appendRetireResolved, appendStagingResolve } from "./staging-resolve";
import { countReanchorRequests, countRetireRequests, readReanchorRequest, readRetireRequest, removeReanchorRequest, removeRetireRequest } from "./curation";
import type { ReanchorRequest, RetireRequest } from "./curation";
import { isTracked } from "./staleness";

export class StagingError extends Error {}

export interface StagingDeps {
  corpus: Corpus;
  projectRoot: string;
  config: MnemeConfig;
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
  | { outcome: "superseded"; noteId: string; supersededId: string; commit: string; suggested: boolean }
  | { outcome: "retired"; requestId: string; noteId: string; commit: string }
  | { outcome: "retire_rejected"; requestId: string; noteId: string }
  | { outcome: "reanchored"; requestId: string; noteId: string; oldAnchor: string; newAnchor: string; commit: string }
  | { outcome: "reanchor_rejected"; requestId: string; noteId: string };

const NOTE_EXTENSION = ".md";

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
  const classification = await classifyCandidate(deps.corpus.indexPath, deps.embeddings, input.body, deps.config.dedup);
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
  emitRemember(deps, noteId, input, dedupPayload("noop", existingId, similarity, false, deps.config.dedup));
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
  const sidecar = sidecarFor(classification, deps.config.dedup);
  writeFileSync(notePath(deps.corpus.stagingDir, noteId), serialized);
  writeSidecar(deps.corpus, noteId, sidecar);
  emitRemember(deps, noteId, input, dedupFromClassification(classification, deps.config.dedup));
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

// The cheap read the workflow boundary needs: how many decisions await review — staged notes AND
// queued retire/re-anchor requests — with no liveness resolution, no sidecar reads and no
// staging_listed event; listing stays the reviewed act.
export function countStagedNotes(corpus: Corpus): number {
  const stagedNotes = readdirSync(corpus.stagingDir).filter((name) => name.endsWith(NOTE_EXTENSION)).length;
  return stagedNotes + countRetireRequests(corpus) + countReanchorRequests(corpus);
}

export async function stagingList(deps: StagingDeps): Promise<StagingEntry[]> {
  const files = readdirSync(deps.corpus.stagingDir)
    .filter((name) => name.endsWith(NOTE_EXTENSION))
    .sort();
  const entries: StagingEntry[] = [];
  // The branch-tips context is built ONCE for the listing, never per staged note.
  const context = await createLivenessContext(deps.projectRoot);
  for (const file of files) {
    entries.push(await stagingEntry(deps.corpus, context, file));
  }
  deps.eventWriter.append({
    type: "staging_listed",
    count: entries.length,
    liveness: entries.map((entry) => ({ id: entry.id, anchors: entry.anchors })),
  });
  return entries;
}

async function stagingEntry(corpus: Corpus, context: LivenessContext, file: string): Promise<StagingEntry> {
  const id = file.slice(0, -NOTE_EXTENSION.length);
  const note = parseNote(readFileSync(join(corpus.stagingDir, file), "utf8"));
  return {
    id,
    type: note.frontmatter.type,
    digest: firstLine(note.body),
    anchors: await probeMissingAnchors(context, await resolveAnchorLiveness(context, note.frontmatter.anchors)),
    dedup: dedupSummary(readSidecar(corpus, id)),
  };
}

// The intake concept-anchor probe runs ONLY for missing anchors of staged notes (a handful at
// most): a path git never saw earns the "likely a concept, not a file" warning downstream.
async function probeMissingAnchors(context: LivenessContext, anchors: StagedAnchor[]): Promise<StagedAnchor[]> {
  return Promise.all(
    anchors.map(async (anchor) =>
      anchor.liveness === "missing"
        ? { ...anchor, everExisted: await pathEverExisted(context.projectRoot, anchor.path) }
        : anchor,
    ),
  );
}

function firstLine(body: string): string {
  const newlineIndex = body.indexOf("\n");
  return newlineIndex === -1 ? body : body.slice(0, newlineIndex);
}

export async function stagingResolve(deps: StagingDeps, id: string, decision: ResolveDecision): Promise<ResolveResult> {
  if (!isNoteId(id)) {
    throw new StagingError(`invalid staged note id: ${id}`);
  }
  const retireRequest = readRetireRequest(deps.corpus, id);
  if (retireRequest !== undefined) {
    return resolveRetireRequest(deps, retireRequest, decision);
  }
  const reanchorRequest = readReanchorRequest(deps.corpus, id);
  if (reanchorRequest !== undefined) {
    return resolveReanchorRequest(deps, reanchorRequest, decision);
  }
  if (decision === "reject") {
    return rejectNote(deps, id);
  }
  if (decision === "accept") {
    return acceptNote(deps, id);
  }
  return supersedeNote(deps, id, decision.supersede);
}

// The retire decision resolves like any staged item: accept rewrites the note's frontmatter
// (retired: true) in place — the file stays in notes/ as history — commits the corpus, and rebuilds
// so recall and dedup stop seeing it; reject just drops the request. Both outcomes are logged.
async function resolveRetireRequest(
  deps: StagingDeps,
  request: RetireRequest,
  decision: ResolveDecision,
): Promise<ResolveResult> {
  if (decision !== "accept" && decision !== "reject") {
    throw new StagingError(`a retire request resolves with accept or reject only: ${request.requestId}`);
  }
  if (decision === "reject") {
    removeRetireRequest(deps.corpus, request.requestId);
    appendRetireResolved(deps, request.requestId, request.targetId, "reject", null);
    return { outcome: "retire_rejected", requestId: request.requestId, noteId: request.targetId };
  }
  markNoteRetired(deps.corpus, request.targetId);
  const commit = await commitPaths(
    deps.corpus,
    [notesRelPath(request.targetId)],
    `Retire note ${shortId(request.targetId)}`,
  );
  removeRetireRequest(deps.corpus, request.requestId);
  appendRetireResolved(deps, request.requestId, request.targetId, "accept", commit);
  await rebuild(rebuildDeps(deps));
  return { outcome: "retired", requestId: request.requestId, noteId: request.targetId, commit };
}

// The re-anchor decision resolves like a retire: accept re-checks the new path is still tracked
// (the tree may have moved between staging and the decision — a failure keeps the request queued),
// rewrites the note's anchors in place, commits the corpus, and rebuilds; reject drops the request.
async function resolveReanchorRequest(
  deps: StagingDeps,
  request: ReanchorRequest,
  decision: ResolveDecision,
): Promise<ResolveResult> {
  if (decision !== "accept" && decision !== "reject") {
    throw new StagingError(`a re-anchor request resolves with accept or reject only: ${request.requestId}`);
  }
  if (decision === "reject") {
    removeReanchorRequest(deps.corpus, request.requestId);
    appendReanchorResolved(deps, request.requestId, request.targetId, "reject", null);
    return { outcome: "reanchor_rejected", requestId: request.requestId, noteId: request.targetId };
  }
  if (!(await isTracked(deps.projectRoot, request.newAnchor))) {
    throw new StagingError(
      `new anchor ${request.newAnchor} is no longer tracked by the project's git; ` +
        `request ${request.requestId} stays queued — restore the path or reject the request`,
    );
  }
  markNoteReanchored(deps.corpus, request);
  const commit = await commitPaths(
    deps.corpus,
    [notesRelPath(request.targetId)],
    `Re-anchor note ${shortId(request.targetId)}`,
  );
  removeReanchorRequest(deps.corpus, request.requestId);
  appendReanchorResolved(deps, request.requestId, request.targetId, "accept", commit);
  await rebuild(rebuildDeps(deps));
  return {
    outcome: "reanchored",
    requestId: request.requestId,
    noteId: request.targetId,
    oldAnchor: request.oldAnchor,
    newAnchor: request.newAnchor,
    commit,
  };
}

// Retry-convergent, the resolve non-atomicity discipline: a crash after the rewrite but before the
// commit re-runs cleanly — anchors already carrying the new path skip the write, and commitPaths
// returns the existing HEAD on an empty diff.
function markNoteReanchored(corpus: Corpus, request: ReanchorRequest): void {
  const path = notePath(corpus.notesDir, request.targetId);
  if (!existsSync(path)) {
    throw new StagingError(`no note to re-anchor: ${request.targetId}`);
  }
  const note = parseNote(readFileSync(path, "utf8"));
  if (!note.frontmatter.anchors.includes(request.oldAnchor)) {
    if (note.frontmatter.anchors.includes(request.newAnchor)) return;
    throw new StagingError(`note ${request.targetId} does not anchor ${request.oldAnchor}`);
  }
  const anchors = [
    ...new Set(note.frontmatter.anchors.map((anchor) => (anchor === request.oldAnchor ? request.newAnchor : anchor))),
  ];
  writeFileSync(path, serializeNote({ frontmatter: { ...note.frontmatter, anchors }, body: note.body }));
}

function markNoteRetired(corpus: Corpus, targetId: string): void {
  const path = notePath(corpus.notesDir, targetId);
  if (!existsSync(path)) {
    throw new StagingError(`no note to retire: ${targetId}`);
  }
  const note = parseNote(readFileSync(path, "utf8"));
  writeFileSync(path, serializeNote({ frontmatter: { ...note.frontmatter, retired: true }, body: note.body }));
}

async function acceptNote(deps: StagingDeps, id: string): Promise<ResolveResult> {
  moveStagedToNotes(deps.corpus, id, (frontmatter) => frontmatter);
  const commit = await commitPaths(deps.corpus, [notesRelPath(id)], `Add note ${shortId(id)}`);
  appendStagingResolve(deps, id, "accept", { commit, superseded_id: null, suggested: null });
  removeSidecar(deps.corpus, id);
  await rebuild(rebuildDeps(deps));
  return { outcome: "accepted", noteId: id, commit };
}

async function supersedeNote(deps: StagingDeps, id: string, target: string): Promise<ResolveResult> {
  validateSupersedeTarget(deps.corpus, id, target);
  const suggested = readSidecar(deps.corpus, id)?.nearest_id === target;
  moveStagedToNotes(deps.corpus, id, (frontmatter) => ({ ...frontmatter, supersedes: target }));
  const commit = await commitPaths(deps.corpus, [notesRelPath(id)], `Supersede ${shortId(target)} with ${shortId(id)}`);
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
