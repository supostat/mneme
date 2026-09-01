import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  USED_NOTES_FIELD,
  USED_NOTES_WITHOUT_HARVEST,
  USED_NOTE_BUNDLE_UNKNOWN,
  USED_NOTE_NOT_IN_BUNDLE,
} from "../src/workflow/used-notes";

// The handoff document tells the skill side how to fill used_notes, so it quotes the engine's own
// refusal texts. Prose drifts silently (the README said "seven" three tool-generations after the
// surface grew to eleven), and a contract document that misquotes the errors it documents is worse
// than none. This guard pins COVERAGE the readme-tools way: every exported piece of the contract
// must appear VERBATIM in the document, so renaming a refusal without updating the document turns a
// silent drift into a red suite. Prose and numerals are deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-USED-NOTES.md");

// The evidence requirement lives in the SDK schema (mcp-tools.ts) rather than the contract module,
// so it is pinned by reading the source the way readme-tools reads registerTool names.
const EVIDENCE_REQUIREMENT_PATTERN = /message: "(evidence must name[^"]+)"/;

function contractStrings(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src", "workflow", "mcp-tools.ts"), "utf8");
  const evidenceRequirement = EVIDENCE_REQUIREMENT_PATTERN.exec(source)?.[1];
  if (evidenceRequirement === undefined) {
    throw new Error("the evidence requirement message is no longer where the guard reads it");
  }
  return [
    USED_NOTES_FIELD,
    USED_NOTES_WITHOUT_HARVEST,
    USED_NOTE_NOT_IN_BUNDLE,
    USED_NOTE_BUNDLE_UNKNOWN,
    evidenceRequirement,
  ];
}

describe("HANDOFF-USED-NOTES contract coverage", () => {
  test("the guard reads a non-empty contract (the guard's own guard)", () => {
    const strings = contractStrings();

    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((value) => value.length > 0)).toBe(true);
    expect(new Set(strings).size).toBe(strings.length);
  });

  test("every piece of the engine's contract appears verbatim in the handoff document", () => {
    const document = readFileSync(HANDOFF_PATH, "utf8");

    const missing = contractStrings().filter((value) => !document.includes(value));

    expect(missing).toEqual([]);
  });

  test("each documented section carries its anchor marker, so a rewrite cannot drop one silently", () => {
    const document = readFileSync(HANDOFF_PATH, "utf8");

    for (const marker of [
      "HANDOFF-USED-NOTES-FIELD",
      "HANDOFF-USED-EVIDENCE",
      "HANDOFF-USED-REFUSALS",
      "HANDOFF-USED-EMPTY",
      "HANDOFF-USED-NEUTRALITY",
    ]) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });
});
