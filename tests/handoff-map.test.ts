import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAP_SECTIONS_COMPONENT } from "../src/doctor";
import { MAP_SECTION_LIMIT_RULE } from "../src/map/map-section";
import { MAP_FENCE_BEGIN_LABEL } from "../src/mcp-rendering";
import { RECALL_GAP_NOTICE } from "../src/recall";

// The handoff document tells the plugin's setup, plan, dev and arch skills how the project map is
// stored, written and recalled and how a memory gap is announced, so it quotes the engine's own
// texts. This guard pins COVERAGE the handoff-note-body way — every exported piece of the contract
// and every map tool name must appear VERBATIM — and checks the document's example recall answer
// against the REAL fence label, so a skill that copies the example parses what the engine actually
// prints. Prose and numerals are deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-MAP.md");
const SERVER_SOURCE_PATH = join(REPO_ROOT, "src", "mcp-server.ts");
const RECALL_MARKER = "<!-- HANDOFF-MAP-RECALL -->";
const MARKERS = [
  "HANDOFF-MAP-STORAGE",
  "HANDOFF-MAP-TOOLS",
  "HANDOFF-MAP-RECALL",
  "HANDOFF-MAP-GAP",
  "HANDOFF-MAP-SKILLS",
];
const SECTION_HEADING_PREFIX = "## ";
const CODE_FENCE = "```";
const MAP_TOOL_PREFIX = "map_";
const MAP_FENCE_BEGIN = new RegExp(`^----- ${MAP_FENCE_BEGIN_LABEL} ([0-9a-f]{16}) -----$`);
const KIND_LINE_PREFIX = "kind: ";
const NOTES_LINE_PREFIX = "notes: ";

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

// The map tools are read from the server source exactly as the README guard reads every tool, so a
// renamed or added map tool fails here before the document can go stale.
function mapToolNames(): string[] {
  const source = readFileSync(SERVER_SOURCE_PATH, "utf8");
  return [...source.matchAll(/registerTool\("([a-z_]+)"/g)]
    .map((match) => match[1]!)
    .filter((name) => name.startsWith(MAP_TOOL_PREFIX));
}

function contractStrings(): string[] {
  return [MAP_SECTION_LIMIT_RULE, RECALL_GAP_NOTICE, MAP_SECTIONS_COMPONENT, MAP_FENCE_BEGIN_LABEL];
}

function recallSectionLines(document: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.includes(RECALL_MARKER));
  if (start === -1) {
    throw new Error(`the handoff document has no ${RECALL_MARKER} section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(SECTION_HEADING_PREFIX));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// The first code block of the recall section, between its opening and closing fence.
function exampleBlock(sectionLines: string[]): string[] {
  const open = sectionLines.findIndex((line) => line.startsWith(CODE_FENCE));
  const close = sectionLines.findIndex((line, index) => index > open && line === CODE_FENCE);
  if (open === -1 || close === -1) {
    throw new Error("the recall section shows no example block");
  }
  return sectionLines.slice(open + 1, close);
}

describe("HANDOFF-MAP contract coverage", () => {
  test("the guard reads a non-empty contract and exactly three map tools (the guard's own guard)", () => {
    const strings = contractStrings();

    expect(strings.every((value) => value.length > 0)).toBe(true);
    expect(new Set(strings).size).toBe(strings.length);
    expect(mapToolNames().sort()).toEqual(["map_delete", "map_list", "map_put"]);
  });

  test("every piece of the engine's contract appears verbatim in the handoff document", () => {
    const document = handoffDocument();

    const missing = contractStrings().filter((value) => !document.includes(value));

    expect(missing).toEqual([]);
  });

  test("every map tool is named in the handoff document as a backticked name", () => {
    const document = handoffDocument();

    const missing = mapToolNames().filter((name) => !document.includes(`\`${name}\``));

    expect(missing).toEqual([]);
  });

  test("each documented section carries its anchor marker, so a rewrite cannot drop one silently", () => {
    const document = handoffDocument();

    for (const marker of MARKERS) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });

  test("the example recall answer opens with a map block whose kind and notes precede the body, then a note block under the same nonce", () => {
    const block = exampleBlock(recallSectionLines(handoffDocument()));
    const nonce = MAP_FENCE_BEGIN.exec(block[0] ?? "")?.[1];
    if (nonce === undefined) {
      throw new Error("the example block does not open with a map fence");
    }

    const kind = block.findIndex((line) => line.startsWith(KIND_LINE_PREFIX));
    const notes = block.findIndex((line) => line.startsWith(NOTES_LINE_PREFIX));
    const mapEnd = block.indexOf(`----- END MNEME MAP ${nonce} -----`);

    expect(kind).toBeGreaterThan(0);
    expect(notes).toBeGreaterThan(kind);
    // At least one body line sits between notes: and the closing map fence.
    expect(mapEnd).toBeGreaterThan(notes + 1);
    expect(block[mapEnd + 1]).toBe(`----- BEGIN MNEME NOTE ${nonce} -----`);
    expect(block[block.length - 1]).toBe(`----- END MNEME NOTE ${nonce} -----`);
  });
});
