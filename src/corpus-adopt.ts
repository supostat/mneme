import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, corpusPaths, readManifest } from "./corpus";
import { commitPaths } from "./corpus-git";
import { classifyCandidate } from "./dedup";
import { rebuild } from "./index-db";
import { isNoteId, parseNote } from "./note";
import { rebuildDeps } from "./staging";
import type { StagingDeps } from "./staging";

// Merging a corpus that drifted apart from this one: two working copies of a project used to derive
// two corpora, and the notes accepted in each are both real memory. Adoption copies the SOURCE's
// notes into the receiving corpus, which is the corpus of the current project.
//
// Both sides already passed the human staging gate, so nothing is re-staged — re-asking for approval
// of memory a human already approved would be theatre. The dedup check against the RECEIVING corpus
// is a different question and is honest: the same knowledge may have been remembered twice, once per
// copy, and only the receiving corpus can say so.
//
// The source is strictly READ-ONLY: it is never emptied, moved or rewritten. Deleting the old folder
// stays the user's move, after they have looked at the result.
//
// The steps are ORDERED and each is IDEMPOTENT, so a crash between any two converges on re-run (the
// staging_resolve precedent): a note already present by id is skipped, the index rebuild derives
// from notes/, and commitPaths turns an empty diff into "no commit, existing HEAD".

export class CorpusAdoptError extends Error {}

const NOTE_EXTENSION = ".md";
const EMBEDDER_PROBE = "mneme corpus adoption probe";

export interface AdoptedNote {
  id: string;
  reason: "adopted" | "already-present" | "duplicate";
  nearestId?: string;
  similarity?: number;
}

export interface AdoptOutcome {
  sourcePath: string;
  notes: AdoptedNote[];
  adoptedCount: number;
  skippedCount: number;
  commit: string | null;
}

export async function adoptCorpus(deps: StagingDeps, sourceCorpusDir: string): Promise<AdoptOutcome> {
  const source = validateSource(deps, sourceCorpusDir);
  await requireEmbedder(deps);

  const notes: AdoptedNote[] = [];
  const sourceIds: string[] = [];
  for (const id of sourceNoteIds(source.notesDir)) {
    sourceIds.push(id);
    notes.push(await adoptOne(deps, source.notesDir, id));
  }

  const present = sourceIds.filter((id) => existsSync(notePath(deps.corpus.notesDir, id)));
  await rebuild(rebuildDeps(deps));
  const commit =
    present.length === 0
      ? null
      : await commitPaths(deps.corpus, present.map(notesRelativePath), `Adopt notes from ${source.path}`);
  const adoptedCount = notes.filter((note) => note.reason === "adopted").length;
  deps.eventWriter.append({
    type: "corpus_adopted",
    source_path: source.path,
    adopted_n: adoptedCount,
    skipped_n: notes.length - adoptedCount,
  });
  return {
    sourcePath: source.path,
    notes,
    adoptedCount,
    skippedCount: notes.length - adoptedCount,
    commit,
  };
}

// The source is validated as a REAL corpus through the same readManifest every other reader uses —
// a directory that merely looks like one is refused before anything is copied. An older manifest is
// refused with the cure named: opening that copy once with this engine migrates it in place, which
// keeps adoption itself free of any write to the source.
function validateSource(deps: StagingDeps, sourceCorpusDir: string): { path: string; notesDir: string } {
  if (!existsSync(sourceCorpusDir)) {
    throw new CorpusAdoptError(`source corpus does not exist: ${sourceCorpusDir}`);
  }
  const path = canonicalize(sourceCorpusDir);
  if (path === canonicalize(deps.corpus.corpusDir)) {
    throw new CorpusAdoptError(`source corpus is the corpus of this project: ${path}`);
  }
  const paths = corpusPaths(path);
  try {
    readManifest(paths.manifestPath);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    throw new CorpusAdoptError(
      `source corpus is not readable: ${problem}. Open that project once with this engine version to migrate its manifest, then adopt it.`,
    );
  }
  if (!existsSync(paths.notesDir)) {
    throw new CorpusAdoptError(`source corpus has no notes directory: ${paths.notesDir}`);
  }
  return { path, notesDir: paths.notesDir };
}

// The dedup check is the whole reason this is a tool rather than a documented `cp`, so an
// unreachable embedder aborts BEFORE the first copy: a silent no-dedup adoption would pour
// duplicates into the corpus with no way to tell afterwards which ones they were.
async function requireEmbedder(deps: StagingDeps): Promise<void> {
  const probe = await deps.embeddings.embed([EMBEDDER_PROBE]);
  if (!probe.available) {
    throw new CorpusAdoptError(
      "the embedder is unavailable, so adopted notes could not be dedup-checked against this corpus; start it and retry",
    );
  }
}

// Every id comes from a FOREIGN directory listing and is joined into a path of this corpus, so it
// passes the shared id grammar first — the index-row discipline applied to another corpus's files.
function sourceNoteIds(notesDir: string): string[] {
  const ids = readdirSync(notesDir)
    .filter((name) => name.endsWith(NOTE_EXTENSION))
    .map((name) => name.slice(0, -NOTE_EXTENSION.length))
    .sort();
  const invalid = ids.filter((id) => !isNoteId(id));
  if (invalid.length > 0) {
    throw new CorpusAdoptError(`source corpus holds files that are not notes: ${invalid.join(", ")}`);
  }
  return ids;
}

async function adoptOne(deps: StagingDeps, sourceNotesDir: string, id: string): Promise<AdoptedNote> {
  const target = notePath(deps.corpus.notesDir, id);
  if (existsSync(target)) {
    return { id, reason: "already-present" };
  }
  const sourcePath = notePath(sourceNotesDir, id);
  const note = parseNote(readFileSync(sourcePath, "utf8"));
  const classification = await classifyCandidate(
    deps.corpus.indexPath,
    deps.embeddings,
    note.body,
    deps.config.dedup,
  );
  if (classification.kind === "noop") {
    return {
      id,
      reason: "duplicate",
      nearestId: classification.neighborId,
      similarity: classification.similarity,
    };
  }
  copyFileSync(sourcePath, target);
  return { id, reason: "adopted" };
}

function notePath(directory: string, id: string): string {
  return join(directory, `${id}${NOTE_EXTENSION}`);
}

function notesRelativePath(id: string): string {
  return `notes/${id}${NOTE_EXTENSION}`;
}
