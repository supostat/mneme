import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  borrowCommitIdentities,
  planCommitIdentityCapture,
  readStoredCommitIdentities,
  writeCommitIdentityCapture,
} from "./commit-identity-store";
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
  const sourceIdentities = readStoredCommitIdentities(source.commitIdentitiesDir);

  const verdicts: SourceNoteVerdict[] = [];
  for (const id of sourceNoteIds(source.notesDir)) {
    verdicts.push(await classifySourceNote(deps, source.notesDir, id));
  }
  const adopting = verdicts.filter((verdict) => verdict.note.reason === "adopted");
  const adoptedCommits = adopting.map((verdict) => verdict.commit);
  const capture = borrowCommitIdentities(
    await planCommitIdentityCapture(deps, adoptedCommits),
    sourceIdentities,
    adoptedCommits,
    deps.corpus.commitIdentitiesDir,
  );
  for (const verdict of adopting) {
    copyFileSync(notePath(source.notesDir, verdict.note.id), notePath(deps.corpus.notesDir, verdict.note.id));
  }
  const notes = verdicts.map((verdict) => verdict.note);

  const present = verdicts
    .map((verdict) => verdict.note.id)
    .filter((id) => existsSync(notePath(deps.corpus.notesDir, id)));
  const committing = [...present.map(notesRelativePath), ...(await writeCommitIdentityCapture(deps.corpus, capture))];
  await rebuild(rebuildDeps(deps));
  const commit =
    committing.length === 0 ? null : await commitPaths(deps.corpus, committing, `Adopt notes from ${source.path}`);
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
function validateSource(
  deps: StagingDeps,
  sourceCorpusDir: string,
): { path: string; notesDir: string; commitIdentitiesDir: string } {
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
  return { path, notesDir: paths.notesDir, commitIdentitiesDir: paths.commitIdentitiesDir };
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

interface SourceNoteVerdict {
  note: AdoptedNote;
  commit: string;
}

// Decides without writing: the dedup neighborhood is the receiving index, which no copy of this pass
// changes, so every verdict can be taken before the first note crosses.
async function classifySourceNote(deps: StagingDeps, sourceNotesDir: string, id: string): Promise<SourceNoteVerdict> {
  const note = parseNote(readFileSync(notePath(sourceNotesDir, id), "utf8"));
  const commit = note.frontmatter.commit;
  if (existsSync(notePath(deps.corpus.notesDir, id))) {
    return { note: { id, reason: "already-present" }, commit };
  }
  const classification = await classifyCandidate(
    deps.corpus.indexPath,
    deps.embeddings,
    note.body,
    deps.config.dedup,
  );
  if (classification.kind === "noop") {
    return {
      note: { id, reason: "duplicate", nearestId: classification.neighborId, similarity: classification.similarity },
      commit,
    };
  }
  return { note: { id, reason: "adopted" }, commit };
}

function notePath(directory: string, id: string): string {
  return join(directory, `${id}${NOTE_EXTENSION}`);
}

function notesRelativePath(id: string): string {
  return `notes/${id}${NOTE_EXTENSION}`;
}
