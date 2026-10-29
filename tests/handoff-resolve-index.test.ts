import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatResolve, INDEX_CATCH_UP_ADVICE, INDEX_NOT_REBUILT_LABEL } from "../src/mcp-rendering";

// The handoff document tells the plugin's dev, plan and fix skills what a staging_resolve result
// looks like when the decision was committed but the index rebuild failed, so it quotes the engine's
// own texts. This guard pins COVERAGE the handoff-note-body way — every exported piece of the
// contract must appear VERBATIM — and checks the document's example block against the REAL
// renderer, so a skill that copies the example parses what the engine actually prints. Prose is
// deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-RESOLVE-INDEX.md");
const SHAPE_MARKER = "<!-- HANDOFF-RESOLVE-INDEX-SHAPE -->";
const SECTION_HEADING_PREFIX = "## ";
const CODE_FENCE = "```";
const ACCEPTED_LINE = /^Accepted note (\S+); committed ([0-9a-f]{40})\.$/;

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

function contractStrings(): string[] {
  return [INDEX_NOT_REBUILT_LABEL, INDEX_CATCH_UP_ADVICE];
}

function shapeSectionLines(document: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.includes(SHAPE_MARKER));
  if (start === -1) {
    throw new Error(`the handoff document has no ${SHAPE_MARKER} section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(SECTION_HEADING_PREFIX));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// The first code block of the shape section, between its opening and closing fence.
function exampleBlock(sectionLines: string[]): string[] {
  const open = sectionLines.findIndex((line) => line.startsWith(CODE_FENCE));
  const close = sectionLines.findIndex((line, index) => index > open && line === CODE_FENCE);
  if (open === -1 || close === -1) {
    throw new Error("the shape section shows no example block");
  }
  return sectionLines.slice(open + 1, close);
}

describe("HANDOFF-RESOLVE-INDEX contract coverage", () => {
  test("the guard reads a non-empty contract (the guard's own guard)", () => {
    const strings = contractStrings();

    expect(strings.every((value) => value.length > 0)).toBe(true);
    expect(new Set(strings).size).toBe(strings.length);
  });

  test("every piece of the engine's contract appears verbatim in the handoff document", () => {
    const document = handoffDocument();

    const missing = contractStrings().filter((value) => !document.includes(value));

    expect(missing).toEqual([]);
  });

  test("each documented section carries its anchor marker, so a rewrite cannot drop one silently", () => {
    const document = handoffDocument();

    for (const marker of ["HANDOFF-RESOLVE-INDEX-SHAPE", "HANDOFF-RESOLVE-INDEX-SKILLS"]) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });

  test("the example block is exactly what formatResolve renders for an accepted note whose rebuild failed", () => {
    const block = exampleBlock(shapeSectionLines(handoffDocument()));
    const accepted = ACCEPTED_LINE.exec(block[0] ?? "");
    if (accepted === null) {
      throw new Error("the example block does not open with an accepted-note line");
    }
    const reasonLine = block[1] ?? "";
    if (!reasonLine.startsWith(`${INDEX_NOT_REBUILT_LABEL} `)) {
      throw new Error(`the example's second line does not start with "${INDEX_NOT_REBUILT_LABEL} "`);
    }

    const rendered = formatResolve({
      outcome: "accepted",
      noteId: accepted[1]!,
      commit: accepted[2]!,
      index: { rebuilt: false, reason: reasonLine.slice(INDEX_NOT_REBUILT_LABEL.length + 1) },
    });

    expect(block).toEqual(rendered.split("\n"));
  });
});
