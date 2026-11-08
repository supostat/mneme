import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatDedupLines,
  formatRemember,
  JUDGE_ADOPT_FLAG_PREFIX,
  JUDGE_LINE_PREFIX,
  JUDGE_NOT_RECOMMENDED_SUFFIX,
  JUDGE_RECOMMENDS_SUFFIX,
  JUDGE_UNAVAILABLE_LINE,
} from "../src/mcp-rendering";
import type { JudgeVerdict } from "../src/dedup-judge";

// The handoff document tells the plugin's skills what the judge's line looks like on a staging card
// and in the remember answer, so it quotes the engine's own texts. This guard pins COVERAGE the
// handoff-resolve-index way — every exported piece of the contract must appear VERBATIM — and checks
// both example blocks against the REAL renderers, so a skill that copies an example parses exactly
// what the engine prints. Prose is deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-JUDGE.md");
const SHAPE_MARKER = "<!-- HANDOFF-JUDGE-SHAPE -->";
const SECTION_HEADING_PREFIX = "## ";
const CODE_FENCE = "```";
const JUDGE_LINE = /^judge: (\w+) (\d\.\d\d)(.*)$/;
const RECOMMENDS_TAIL = /^ — recommends supersede of (\S+)$/;
const STAGED_LINE = /^Staged note (\S+) for human review\.$/;
const READING_LINE = /^The judge reads it as superseding (\S+) \((\w+) (\d\.\d\d)\); /;

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

function contractStrings(): string[] {
  return [JUDGE_LINE_PREFIX, JUDGE_RECOMMENDS_SUFFIX, JUDGE_NOT_RECOMMENDED_SUFFIX, JUDGE_UNAVAILABLE_LINE, JUDGE_ADOPT_FLAG_PREFIX];
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

// Every code block of the shape section, in order, each as its lines between the fences.
function exampleBlocks(sectionLines: string[]): string[][] {
  const blocks: string[][] = [];
  let open = -1;
  sectionLines.forEach((line, index) => {
    if (!line.startsWith(CODE_FENCE)) return;
    if (open === -1) {
      open = index;
    } else {
      blocks.push(sectionLines.slice(open + 1, index));
      open = -1;
    }
  });
  return blocks;
}

// A verdict whose chosen relation carries the quoted probability; the rest of the mass sits on an
// option the line never names, so the rendered number is exactly the one in the example.
function verdictFor(relation: "supersedes" | "complements", probability: number, neighborId: string, recommended: boolean): JudgeVerdict {
  const rest = Number((1 - probability).toFixed(2));
  return {
    degraded: false,
    model: "jev-1.14.0",
    neighborId,
    relation,
    probabilities: { duplicate: 0, supersedes: relation === "supersedes" ? probability : 0, contradicts: 0, complements: relation === "complements" ? probability : rest, unrelated: relation === "complements" ? 0 : rest },
    confidence: 0.8,
    recommended,
  };
}

describe("HANDOFF-JUDGE contract coverage", () => {
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

    for (const marker of ["HANDOFF-JUDGE-SHAPE", "HANDOFF-JUDGE-SKILLS"]) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });

  test("the first example block is exactly the three judge lines the real card renderer prints", () => {
    const [cardBlock] = exampleBlocks(shapeSectionLines(handoffDocument()));
    if (cardBlock === undefined || cardBlock.length !== 3) {
      throw new Error("the shape section's first block does not show exactly three judge lines");
    }
    const recommending = JUDGE_LINE.exec(cardBlock[0]!);
    const declining = JUDGE_LINE.exec(cardBlock[1]!);
    if (recommending === null || declining === null) {
      throw new Error("the first two example lines are not judge lines");
    }
    const neighborId = RECOMMENDS_TAIL.exec(recommending[3]!)?.[1];
    if (neighborId === undefined) {
      throw new Error("the first example line does not recommend a supersede of a named note");
    }

    // Each card renders the cosine line first and the judge's line second; the example quotes the
    // judge's lines alone, so the cosine line is dropped from every rendering.
    const rendered = [
      ...formatDedupLines({ kind: "no_neighbor", judge: verdictFor("supersedes", Number(recommending[2]), neighborId, true) }).slice(1),
      ...formatDedupLines({ kind: "no_neighbor", judge: verdictFor("complements", Number(declining[2]), neighborId, false) }).slice(1),
      ...formatDedupLines({ kind: "no_neighbor", judge: { degraded: true, model: "jev-1.14.0", neighborId } }).slice(1),
    ];

    expect(cardBlock).toEqual(rendered);
  });

  test("the second example block is exactly what formatRemember prints for a recommending verdict", () => {
    const [, rememberBlock] = exampleBlocks(shapeSectionLines(handoffDocument()));
    const staged = STAGED_LINE.exec(rememberBlock?.[0] ?? "");
    const reading = READING_LINE.exec(rememberBlock?.[1] ?? "");
    if (staged === null || reading === null || reading[2] !== "supersedes") {
      throw new Error("the second example block does not show a remember answer with a supersede reading");
    }

    const rendered = formatRemember({
      outcome: "staged",
      noteId: staged[1]!,
      type: "decision",
      dedup: "add",
      nearestId: null,
      similarity: null,
      degraded: false,
      judge: verdictFor("supersedes", Number(reading[3]), reading[1]!, true),
    });

    expect(rememberBlock).toEqual(rendered.split("\n"));
  });
});
