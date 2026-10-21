import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIPPED_BODIES_COMPONENT } from "../src/doctor";
import { STAGING_BODY_LABEL } from "../src/mcp-rendering";
import { HARVEST_BODY_LIMIT_RULE } from "../src/workflow/harvest-artifacts";

// The handoff document tells the plugin's dev, plan, fix, setup, design and grill-agent skills how a
// harvest is refused, how a staged note is shown and how doctor names clipped notes, so it quotes the
// engine's own texts. This guard pins COVERAGE the handoff-gate-timeout way — every exported piece of
// the contract must appear VERBATIM — and checks the document's example staging block against the
// REAL body label, so a skill that copies the example parses what the engine actually prints. Prose
// and numerals are deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-NOTE-BODY.md");
const STAGING_MARKER = "<!-- HANDOFF-BODY-STAGING -->";
const SECTION_HEADING_PREFIX = "## ";
const CODE_FENCE = "```";
const NOTE_FENCE_BEGIN = /^----- BEGIN MNEME NOTE ([0-9a-f]{16}) -----$/;
const ANCHORS_LINE_PREFIX = "anchors: ";

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

function contractStrings(): string[] {
  return [HARVEST_BODY_LIMIT_RULE, STAGING_BODY_LABEL, CLIPPED_BODIES_COMPONENT];
}

function stagingSectionLines(document: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.includes(STAGING_MARKER));
  if (start === -1) {
    throw new Error(`the handoff document has no ${STAGING_MARKER} section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(SECTION_HEADING_PREFIX));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// The first code block of the staging section, between its opening and closing fence.
function exampleBlock(sectionLines: string[]): string[] {
  const open = sectionLines.findIndex((line) => line.startsWith(CODE_FENCE));
  const close = sectionLines.findIndex((line, index) => index > open && line === CODE_FENCE);
  if (open === -1 || close === -1) {
    throw new Error("the staging section shows no example block");
  }
  return sectionLines.slice(open + 1, close);
}

describe("HANDOFF-NOTE-BODY contract coverage", () => {
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

    for (const marker of [
      "HANDOFF-BODY-HARVEST-LIMIT",
      "HANDOFF-BODY-STAGING",
      "HANDOFF-BODY-CLIPPED",
      "HANDOFF-BODY-SKILLS",
    ]) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });

  test("the example staging block puts the real body label between the metadata and the body", () => {
    const block = exampleBlock(stagingSectionLines(handoffDocument()));
    const nonce = NOTE_FENCE_BEGIN.exec(block[0] ?? "")?.[1];
    if (nonce === undefined) {
      throw new Error("the example block does not open with a note fence");
    }

    const label = block.indexOf(STAGING_BODY_LABEL);
    const anchors = block.findIndex((line) => line.startsWith(ANCHORS_LINE_PREFIX));
    const end = block.indexOf(`----- END MNEME NOTE ${nonce} -----`);

    expect(anchors).toBeGreaterThan(0);
    expect(label).toBeGreaterThan(anchors);
    expect(end).toBe(block.length - 1);
    expect(end - label).toBeGreaterThan(1);
  });
});
