import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLivenessContext, pathEverExisted, resolveAnchorLiveness } from "./anchor-liveness";
import type { Corpus } from "./corpus";
import { REANCHOR_SOURCES } from "./event-schema";
import type { ReanchorSource } from "./event-schema";
import { readActiveNotes } from "./index-db";
import { isNoteId, parseNote, validateAnchor } from "./note";
import type { Note, NoteType } from "./note";
import { isTracked } from "./staleness";
import { appendReanchorStaged, appendRetagStaged, appendRetireStaged } from "./staging-resolve";
import type { StagingDeps } from "./staging";

// Curation of ACCEPTED notes: list them with anchor health, show one in full, and queue a retire
// or re-anchor decision. Neither bypasses the human gate: note_retire and noteReanchor only STAGE
// a request; the decision travels through staging_resolve exactly like an acceptance, and only
// that resolution rewrites the note (retired: true / anchors old -> new) — the file stays in
// notes/ as history, recall picks the change up via rebuild.

export class CurationError extends Error {}

const RETIRE_EXTENSION = ".retire.json";
const REANCHOR_EXTENSION = ".reanchor.json";
const RETAG_EXTENSION = ".retag.json";

export const DEFAULT_NOTES_LIST_LIMIT = 50;

export interface NotesListFilters {
  type?: NoteType;
  deadAnchorsOnly?: boolean;
  limit?: number;
}

export interface NotesListEntry {
  id: string;
  type: NoteType;
  firstLine: string;
  anchorsN: number;
  deadN: number;
}

export interface NotesListResult {
  entries: NotesListEntry[];
  total: number;
}

// Bodies are deliberately absent from the listing — one line per note keeps the curation sweep
// readable; the full body is a separate, per-note show.
export async function notesList(deps: StagingDeps, filters: NotesListFilters): Promise<NotesListResult> {
  const notes = readActiveNotes(deps.corpus.notesDir).filter(
    (note) => filters.type === undefined || note.frontmatter.type === filters.type,
  );
  const entries: NotesListEntry[] = [];
  // Liveness checks stay strictly sequential: unbounded parallel git spawns are a named debt.
  // The branch-tips context is built ONCE for the listing, never inside the loop.
  const context = await createLivenessContext(deps.projectRoot);
  for (const note of notes) {
    const anchors = await resolveAnchorLiveness(context, note.frontmatter.anchors);
    entries.push({
      id: note.frontmatter.id,
      type: note.frontmatter.type,
      firstLine: firstLineOf(note.body),
      anchorsN: anchors.length,
      deadN: anchors.filter((anchor) => anchor.liveness === "missing").length,
    });
  }
  const matching = filters.deadAnchorsOnly === true ? entries.filter((entry) => entry.deadN > 0) : entries;
  const limit = filters.limit ?? DEFAULT_NOTES_LIST_LIMIT;
  return { entries: matching.slice(0, limit), total: matching.length };
}

export function showNote(corpus: Corpus, id: string): Note {
  if (!isNoteId(id)) {
    throw new CurationError(`invalid note id: ${id}`);
  }
  const path = join(corpus.notesDir, `${id}.md`);
  if (!existsSync(path)) {
    throw new CurationError(`no note ${id} exists in the corpus`);
  }
  return parseNote(readFileSync(path, "utf8"));
}

export interface RetireRequest {
  requestId: string;
  targetId: string;
  reason: string;
}

export interface StagedRetire {
  requestId: string;
  targetId: string;
}

export function noteRetire(deps: StagingDeps, targetId: string, reason: string): StagedRetire {
  requireCleanReason(reason);
  const target = showNote(deps.corpus, targetId);
  if (target.frontmatter.retired === true) {
    throw new CurationError(`note ${targetId} is already retired`);
  }
  const pending = listRetireRequests(deps.corpus).find((request) => request.targetId === targetId);
  if (pending !== undefined) {
    throw new CurationError(
      `note ${targetId} already has a pending retire request ${pending.requestId}; resolve it first`,
    );
  }
  const requestId = deps.idFactory();
  if (!isNoteId(requestId)) {
    throw new CurationError(`idFactory produced an invalid request id: ${requestId}`);
  }
  writeFileSync(
    retirePath(deps.corpus, requestId),
    JSON.stringify({ request_id: requestId, target_id: targetId, reason }, null, 2) + "\n",
  );
  appendRetireStaged(deps, requestId, targetId, reason);
  return { requestId, targetId };
}

export function listRetireRequests(corpus: Corpus): RetireRequest[] {
  return readdirSync(corpus.stagingDir)
    .filter((name) => name.endsWith(RETIRE_EXTENSION))
    .sort()
    .map((name) => requireRetireRequest(corpus, name.slice(0, -RETIRE_EXTENSION.length)));
}

export function readRetireRequest(corpus: Corpus, requestId: string): RetireRequest | undefined {
  if (!existsSync(retirePath(corpus, requestId))) {
    return undefined;
  }
  return requireRetireRequest(corpus, requestId);
}

export function removeRetireRequest(corpus: Corpus, requestId: string): void {
  rmSync(retirePath(corpus, requestId), { force: true });
}

export function countRetireRequests(corpus: Corpus): number {
  return readdirSync(corpus.stagingDir).filter((name) => name.endsWith(RETIRE_EXTENSION)).length;
}

// Fail-closed read: a request file that lost its shape is a named error, never a silently skipped
// queue entry — the human gate must see everything that was queued.
function requireRetireRequest(corpus: Corpus, requestId: string): RetireRequest {
  const parsed: unknown = JSON.parse(readFileSync(retirePath(corpus, requestId), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new CurationError(`retire request ${requestId} is not a JSON object`);
  }
  const record = parsed as { request_id?: unknown; target_id?: unknown; reason?: unknown };
  if (record.request_id !== requestId) {
    throw new CurationError(`retire request ${requestId} names a different request_id`);
  }
  if (typeof record.target_id !== "string" || !isNoteId(record.target_id)) {
    throw new CurationError(`retire request ${requestId} has an invalid target_id`);
  }
  if (typeof record.reason !== "string") {
    throw new CurationError(`retire request ${requestId} has no reason`);
  }
  return { requestId, targetId: record.target_id, reason: record.reason };
}

function retirePath(corpus: Corpus, requestId: string): string {
  return join(corpus.stagingDir, `${requestId}${RETIRE_EXTENSION}`);
}

export interface ReanchorRequest {
  requestId: string;
  targetId: string;
  oldAnchor: string;
  newAnchor: string;
  score: number | null;
  source: ReanchorSource;
}

export interface StagedReanchor {
  requestId: string;
  targetId: string;
}

// Stages an anchor replacement for the human gate. Repair is for MISSING anchors only: a tracked
// anchor needs no repair and an untracked-exists one is a fresh uncommitted file, not a loss — both
// refuse, which is what makes a re-run over a repaired corpus silent instead of noisy.
export async function noteReanchor(
  deps: StagingDeps,
  targetId: string,
  oldAnchor: string,
  newAnchor: string,
  score: number | null,
  source: ReanchorSource,
): Promise<StagedReanchor> {
  const target = showNote(deps.corpus, targetId);
  if (target.frontmatter.retired === true) {
    throw new CurationError(`note ${targetId} is retired; a retired note is not re-anchored`);
  }
  if (!target.frontmatter.anchors.includes(oldAnchor)) {
    throw new CurationError(`note ${targetId} does not anchor ${oldAnchor}`);
  }
  validateAnchor(newAnchor);
  const context = await createLivenessContext(deps.projectRoot);
  const [oldLiveness] = await resolveAnchorLiveness(context, [oldAnchor]);
  if (oldLiveness!.liveness === "known-elsewhere") {
    throw new CurationError(
      `anchor ${oldAnchor} lives on branch ${(oldLiveness!.branches ?? []).join(", ")} — ` +
        "wait for the merge, there is nothing to repair",
    );
  }
  if (oldLiveness!.liveness !== "missing") {
    throw new CurationError(
      `anchor ${oldAnchor} is ${oldLiveness!.liveness}, not missing; only a missing anchor is repaired`,
    );
  }
  if (!(await isTracked(deps.projectRoot, newAnchor))) {
    throw new CurationError(`new anchor ${newAnchor} is not tracked by the project's git`);
  }
  const pending = listReanchorRequests(deps.corpus).find(
    (request) => request.targetId === targetId && request.oldAnchor === oldAnchor,
  );
  if (pending !== undefined) {
    throw new CurationError(
      `note ${targetId} already has a pending re-anchor request ${pending.requestId} for ${oldAnchor}; resolve it first`,
    );
  }
  const requestId = deps.idFactory();
  if (!isNoteId(requestId)) {
    throw new CurationError(`idFactory produced an invalid request id: ${requestId}`);
  }
  writeFileSync(
    reanchorPath(deps.corpus, requestId),
    JSON.stringify(
      { request_id: requestId, target_id: targetId, old_anchor: oldAnchor, new_anchor: newAnchor, score, source },
      null,
      2,
    ) + "\n",
  );
  appendReanchorStaged(deps, { requestId, targetId, oldAnchor, newAnchor, score, source });
  return { requestId, targetId };
}

export function listReanchorRequests(corpus: Corpus): ReanchorRequest[] {
  return readdirSync(corpus.stagingDir)
    .filter((name) => name.endsWith(REANCHOR_EXTENSION))
    .sort()
    .map((name) => requireReanchorRequest(corpus, name.slice(0, -REANCHOR_EXTENSION.length)));
}

export function readReanchorRequest(corpus: Corpus, requestId: string): ReanchorRequest | undefined {
  if (!existsSync(reanchorPath(corpus, requestId))) {
    return undefined;
  }
  return requireReanchorRequest(corpus, requestId);
}

export function removeReanchorRequest(corpus: Corpus, requestId: string): void {
  rmSync(reanchorPath(corpus, requestId), { force: true });
}

export function countReanchorRequests(corpus: Corpus): number {
  return readdirSync(corpus.stagingDir).filter((name) => name.endsWith(REANCHOR_EXTENSION)).length;
}

// Fail-closed read, the requireRetireRequest discipline: a request file that lost its shape is a
// named error, never a silently skipped queue entry.
function requireReanchorRequest(corpus: Corpus, requestId: string): ReanchorRequest {
  const parsed: unknown = JSON.parse(readFileSync(reanchorPath(corpus, requestId), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new CurationError(`re-anchor request ${requestId} is not a JSON object`);
  }
  const record = parsed as {
    request_id?: unknown;
    target_id?: unknown;
    old_anchor?: unknown;
    new_anchor?: unknown;
    score?: unknown;
    source?: unknown;
  };
  if (record.request_id !== requestId) {
    throw new CurationError(`re-anchor request ${requestId} names a different request_id`);
  }
  if (typeof record.target_id !== "string" || !isNoteId(record.target_id)) {
    throw new CurationError(`re-anchor request ${requestId} has an invalid target_id`);
  }
  if (typeof record.old_anchor !== "string" || record.old_anchor.length === 0) {
    throw new CurationError(`re-anchor request ${requestId} has an invalid old_anchor`);
  }
  if (typeof record.new_anchor !== "string" || record.new_anchor.length === 0) {
    throw new CurationError(`re-anchor request ${requestId} has an invalid new_anchor`);
  }
  if (record.score !== null && typeof record.score !== "number") {
    throw new CurationError(`re-anchor request ${requestId} has an invalid score`);
  }
  if (typeof record.source !== "string" || !(REANCHOR_SOURCES as readonly string[]).includes(record.source)) {
    throw new CurationError(`re-anchor request ${requestId} has an invalid source`);
  }
  return {
    requestId,
    targetId: record.target_id,
    oldAnchor: record.old_anchor,
    newAnchor: record.new_anchor,
    score: record.score,
    source: record.source as ReanchorSource,
  };
}

function reanchorPath(corpus: Corpus, requestId: string): string {
  return join(corpus.stagingDir, `${requestId}${REANCHOR_EXTENSION}`);
}

export interface RetagRequest {
  requestId: string;
  targetId: string;
  anchor: string;
}

export interface StagedRetag {
  requestId: string;
  targetId: string;
}

// Stages an anchor -> tags move for the human gate: the string is knowledge's TOPIC, not its
// address. Retag is for CONCEPT anchors only — the anchor must be missing AND never known to git
// (pathEverExisted false); a path git once saw is an honest deletion and keeps the retire path.
export async function noteRetag(deps: StagingDeps, targetId: string, anchor: string): Promise<StagedRetag> {
  const target = showNote(deps.corpus, targetId);
  if (target.frontmatter.retired === true) {
    throw new CurationError(`note ${targetId} is retired; a retired note is not retagged`);
  }
  if (!target.frontmatter.anchors.includes(anchor)) {
    throw new CurationError(`note ${targetId} does not anchor ${anchor}`);
  }
  const context = await createLivenessContext(deps.projectRoot);
  const [liveness] = await resolveAnchorLiveness(context, [anchor]);
  if (liveness!.liveness !== "missing") {
    throw new CurationError(
      `anchor ${anchor} is ${liveness!.liveness}, not missing; only a concept anchor is retagged`,
    );
  }
  if (await pathEverExisted(deps.projectRoot, anchor)) {
    throw new CurationError(
      `anchor ${anchor} was once a real path in git history — an honest deletion is retired or ` +
        "re-anchored, never retagged",
    );
  }
  const pending = listRetagRequests(deps.corpus).find(
    (request) => request.targetId === targetId && request.anchor === anchor,
  );
  if (pending !== undefined) {
    throw new CurationError(
      `note ${targetId} already has a pending retag request ${pending.requestId} for ${anchor}; resolve it first`,
    );
  }
  const requestId = deps.idFactory();
  if (!isNoteId(requestId)) {
    throw new CurationError(`idFactory produced an invalid request id: ${requestId}`);
  }
  writeFileSync(
    retagPath(deps.corpus, requestId),
    JSON.stringify({ request_id: requestId, target_id: targetId, anchor }, null, 2) + "\n",
  );
  appendRetagStaged(deps, requestId, targetId, anchor);
  return { requestId, targetId };
}

export function listRetagRequests(corpus: Corpus): RetagRequest[] {
  return readdirSync(corpus.stagingDir)
    .filter((name) => name.endsWith(RETAG_EXTENSION))
    .sort()
    .map((name) => requireRetagRequest(corpus, name.slice(0, -RETAG_EXTENSION.length)));
}

export function readRetagRequest(corpus: Corpus, requestId: string): RetagRequest | undefined {
  if (!existsSync(retagPath(corpus, requestId))) {
    return undefined;
  }
  return requireRetagRequest(corpus, requestId);
}

export function removeRetagRequest(corpus: Corpus, requestId: string): void {
  rmSync(retagPath(corpus, requestId), { force: true });
}

export function countRetagRequests(corpus: Corpus): number {
  return readdirSync(corpus.stagingDir).filter((name) => name.endsWith(RETAG_EXTENSION)).length;
}

// Fail-closed read, the requireRetireRequest discipline: a request file that lost its shape is a
// named error, never a silently skipped queue entry.
function requireRetagRequest(corpus: Corpus, requestId: string): RetagRequest {
  const parsed: unknown = JSON.parse(readFileSync(retagPath(corpus, requestId), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new CurationError(`retag request ${requestId} is not a JSON object`);
  }
  const record = parsed as { request_id?: unknown; target_id?: unknown; anchor?: unknown };
  if (record.request_id !== requestId) {
    throw new CurationError(`retag request ${requestId} names a different request_id`);
  }
  if (typeof record.target_id !== "string" || !isNoteId(record.target_id)) {
    throw new CurationError(`retag request ${requestId} has an invalid target_id`);
  }
  if (typeof record.anchor !== "string" || record.anchor.length === 0) {
    throw new CurationError(`retag request ${requestId} has an invalid anchor`);
  }
  return { requestId, targetId: record.target_id, anchor: record.anchor };
}

function retagPath(corpus: Corpus, requestId: string): string {
  return join(corpus.stagingDir, `${requestId}${RETAG_EXTENSION}`);
}

function requireCleanReason(reason: string): void {
  if (reason.trim() === "") {
    throw new CurationError("retire reason must not be blank");
  }
  if (/[\0-\x1f\x7f]/.test(reason)) {
    throw new CurationError("retire reason must be a single line free of control characters");
  }
}

function firstLineOf(body: string): string {
  const newlineIndex = body.indexOf("\n");
  return newlineIndex === -1 ? body : body.slice(0, newlineIndex);
}
