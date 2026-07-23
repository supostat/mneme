import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The README's tool-surface prose drifts silently (it said "seven" three tool-generations after the
// surface grew to eleven). This guard pins COVERAGE, not prose: every tool registered in
// mcp-server.ts must be mentioned in the README as a backticked name, so adding a tool without
// documenting it fails here. Numerals in prose are deliberately not asserted — brittle.

const REPO_ROOT = join(import.meta.dir, "..");

function registeredToolNames(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src", "mcp-server.ts"), "utf8");
  return [...source.matchAll(/registerTool\("([a-z_]+)"/g)].map((match) => match[1]!);
}

describe("README tool coverage", () => {
  test("the source registers a non-empty tool list (the guard's own guard)", () => {
    const names = registeredToolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every registered tool is mentioned in the README as a backticked name", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const missing = registeredToolNames().filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
