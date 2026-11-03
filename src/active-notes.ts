import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "./note";
import type { Note } from "./note";

// The single definition of "active": not superseded and not retired. Rebuild indexes exactly this
// population, so retired notes leave recall AND dedup neighborhoods by never being indexed; the
// curation listing and the commit-identity capture import the same function so the populations
// cannot drift.
export function readActiveNotes(notesDir: string): Note[] {
  const files = readdirSync(notesDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const notes = files.map((file) => parseNote(readFileSync(join(notesDir, file), "utf8")));
  const superseded = new Set(
    notes
      .map((note) => note.frontmatter.supersedes)
      .filter((id): id is string => id !== undefined),
  );
  return notes.filter((note) => !superseded.has(note.frontmatter.id) && note.frontmatter.retired !== true);
}
