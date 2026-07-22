import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAnchorLiveness } from "./anchor-liveness";
import type { Corpus } from "./corpus";
import { readActiveNotes } from "./index-db";
import { isNoteId, parseNote } from "./note";
import type { Note, NoteType } from "./note";
import { appendRetireStaged } from "./staging-resolve";
import type { StagingDeps } from "./staging";

// Curation of ACCEPTED notes: list them with anchor health, show one in full, and queue a retire
// decision. Retire never bypasses the human gate: note_retire only STAGES a request; the decision
// travels through staging_resolve exactly like an acceptance, and only that resolution rewrites the
// note (retired: true) — the file stays in notes/ as history, recall excludes it via rebuild.

export class CurationError extends Error {}

const RETIRE_EXTENSION = ".retire.json";

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
  for (const note of notes) {
    const anchors = await resolveAnchorLiveness(deps.projectRoot, note.frontmatter.anchors);
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
