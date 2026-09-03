import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The handoff document tells the skill side which tool to grant and which flag to pass, so it must
// quote the engine's own names. Prose drifts silently, and a contract document that names a tool
// or a field the engine no longer registers is worse than none. This guard pins COVERAGE the
// readme-tools way: every name is read off the SOURCE (never hard-coded here, so a rename in the
// engine turns into a red suite instead of a guard that keeps passing against a stale literal), and
// each must appear VERBATIM, backticked, in the document. Prose and numerals are not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-SURVEY.md");

// The registration line binds the tool name to its description constant; the input schema binds
// the flag name to its zod type. Both regexes fail LOUDLY when the source moves out from under them.
const SURVEY_REGISTRATION_PATTERN = /registerTool\("([a-z_]+)", \{ description: WORKFLOW_SURVEY_DESCRIPTION/;
const SURVEY_INPUT_FIELD_PATTERN = /export const WORKFLOW_SURVEY_INPUT = \{\s*([a-z_]+): z\.boolean\(\)\.optional\(\)/;

const SECTION_MARKERS = [
  "HANDOFF-SURVEY-TOOL",
  "HANDOFF-SURVEY-BRIEF",
  "HANDOFF-SURVEY-RESUME",
  "HANDOFF-SURVEY-HOOK",
];

function sourceOf(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), "utf8");
}

function contractStrings(): string[] {
  const toolName = SURVEY_REGISTRATION_PATTERN.exec(sourceOf("src", "mcp-server.ts"))?.[1];
  if (toolName === undefined) {
    throw new Error("the survey tool registration is no longer where the guard reads it");
  }
  const briefField = SURVEY_INPUT_FIELD_PATTERN.exec(sourceOf("src", "workflow", "mcp-tools.ts"))?.[1];
  if (briefField === undefined) {
    throw new Error("the survey input field is no longer where the guard reads it");
  }
  return [toolName, briefField];
}

describe("HANDOFF-SURVEY contract coverage", () => {
  test("the guard reads a non-empty contract (the guard's own guard)", () => {
    const strings = contractStrings();

    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((value) => value.length > 0)).toBe(true);
    expect(new Set(strings).size).toBe(strings.length);
  });

  test("every engine name the contract rests on appears verbatim, backticked, in the handoff document", () => {
    const document = readFileSync(HANDOFF_PATH, "utf8");

    const missing = contractStrings().filter((value) => !document.includes(`\`${value}\``));

    expect(missing).toEqual([]);
  });

  test("each documented section carries its anchor marker, so a rewrite cannot drop one silently", () => {
    const document = readFileSync(HANDOFF_PATH, "utf8");

    for (const marker of SECTION_MARKERS) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });
});
