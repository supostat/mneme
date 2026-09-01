import type { BundleNoteRef, UsedNoteRef } from "./run-payloads";

// The usage declaration's contract: the field name, the refusal texts, and the membership check
// that decides whether a declaration may be recorded at all.
//
// These strings are EXPORTED CONSTANTS on purpose. The handoff document that tells the skill side
// how to fill the field quotes them verbatim, and a guard test reads them from here — so renaming a
// refusal without updating the document turns a silent drift into a red suite.
//
// The declaration answers "which of the notes you were HANDED did you lean on", so it is checked
// against the phase's own bundle. That check is what keeps the metric's numerator inside its
// denominator: a note that was never surfaced cannot have been used, and a declaration naming one
// is a mistake worth refusing rather than a datum worth storing.

export class UsedNotesError extends Error {}

export const USED_NOTES_FIELD = "used_notes";

export const USED_NOTES_WITHOUT_HARVEST =
  "used_notes rides the harvest submission: declare the notes you leaned on in the same call that closes the phase";

export const USED_NOTE_NOT_IN_BUNDLE =
  "declared note was not in this phase's recall bundle, so it cannot have been used";

export const USED_NOTE_BUNDLE_UNKNOWN =
  "this phase's recall bundle composition was never recorded, so a usage declaration cannot be checked against it";

// An EMPTY declaration is always legal — "nothing here was useful" is an honest answer that needs
// no ground truth to verify, and refusing it would push the caller toward inventing a use.
export function assertDeclaredNotesInBundle(
  phaseId: string,
  declared: readonly UsedNoteRef[],
  bundleNotesByPhase: Record<string, BundleNoteRef[]>,
): void {
  if (declared.length === 0) {
    return;
  }
  const bundle = bundleNotesByPhase[phaseId];
  if (bundle === undefined) {
    throw new UsedNotesError(`${USED_NOTE_BUNDLE_UNKNOWN} (phase "${phaseId}")`);
  }
  const surfaced = new Set(bundle.map((note) => note.id));
  const strangers = declared.filter((note) => !surfaced.has(note.id)).map((note) => note.id);
  if (strangers.length > 0) {
    throw new UsedNotesError(`${USED_NOTE_NOT_IN_BUNDLE}: ${strangers.join(", ")} (phase "${phaseId}")`);
  }
}
