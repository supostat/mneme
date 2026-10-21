import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FENCE_INFO_STRING_PROBLEM,
  MAX_GATE_TIMEOUT_SECONDS,
  MIN_GATE_TIMEOUT_SECONDS,
  fenceTimeoutSeconds,
} from "../src/workflow/phase-document";
import { INCONCLUSIVE_DIRECTIVE_HEADER } from "../src/workflow/run-directives";
import { INCONCLUSIVE_VERDICT } from "../src/workflow/run-executor";

// The handoff document tells the plugin's plan, migrate and dev skills how gate limits and
// inconclusive gate runs behave, so it quotes the engine's own texts. A contract document that
// misquotes the error it documents is worse than none: this guard pins COVERAGE the
// handoff-used-notes way — every exported piece of the contract must appear VERBATIM — and parses
// the document's own syntax example with the REAL parser, so the example cannot drift into a form
// the engine refuses. Prose and numerals are deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-GATE-TIMEOUT.md");
const LIMIT_MARKER = "<!-- HANDOFF-GATE-LIMIT -->";
const SECTION_HEADING_PREFIX = "## ";
// A fence opening that carries an info string: three backticks, then anything but a backtick.
const INFO_STRING_FENCE = /^```[^`]+$/;

// The bound is a policy constant, not a text, so its NAME is pinned by reading the source the way
// readme-tools reads registerTool names; a rename moves it out from under the pattern and fails loud.
const INCONCLUSIVE_BOUND_PATTERN = /export const (MAX_INCONCLUSIVE_GATE_RUNS) = \d+;/;

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

function contractStrings(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src", "workflow", "failure-policy.ts"), "utf8");
  const boundName = INCONCLUSIVE_BOUND_PATTERN.exec(source)?.[1];
  if (boundName === undefined) {
    throw new Error("the inconclusive re-run bound is no longer where the guard reads it");
  }
  return [FENCE_INFO_STRING_PROBLEM, INCONCLUSIVE_DIRECTIVE_HEADER, INCONCLUSIVE_VERDICT, boundName];
}

function limitSectionLines(document: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.includes(LIMIT_MARKER));
  if (start === -1) {
    throw new Error(`the handoff document has no ${LIMIT_MARKER} section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(SECTION_HEADING_PREFIX));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

describe("HANDOFF-GATE-TIMEOUT contract coverage", () => {
  test("the guard reads a non-empty contract (the guard's own guard)", () => {
    const strings = contractStrings();

    expect(strings.length).toBeGreaterThan(0);
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
      "HANDOFF-GATE-LIMIT",
      "HANDOFF-GATE-DIAGNOSTICS",
      "HANDOFF-GATE-INCONCLUSIVE",
      "HANDOFF-GATE-SKILLS",
    ]) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });

  test("the limit section's syntax example is a fence the real parser accepts", () => {
    const example = limitSectionLines(handoffDocument()).find((line) => INFO_STRING_FENCE.test(line));
    if (example === undefined) {
      throw new Error("the limit section shows no fence carrying an info string");
    }

    const seconds = fenceTimeoutSeconds(example);

    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThanOrEqual(MIN_GATE_TIMEOUT_SECONDS);
    expect(seconds!).toBeLessThanOrEqual(MAX_GATE_TIMEOUT_SECONDS);
  });
});
