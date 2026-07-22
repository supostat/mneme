import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The gate cannot run GitHub Actions, but it CAN guarantee the workflow exists, parses as YAML, and
// carries the three steps the local gates mirror — so CI and the local done-when never drift apart.

const WORKFLOW_PATH = join(import.meta.dir, "..", ".github", "workflows", "ci.yml");

interface WorkflowShape {
  jobs?: Record<string, { steps?: Array<{ run?: string; uses?: string }> }>;
}

function parsedWorkflow(): Record<string, unknown> {
  const parsed = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

function runCommands(): string[] {
  const workflow = parsedWorkflow() as WorkflowShape;
  const jobs = workflow.jobs ?? {};
  return Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
}

describe("CI workflow", () => {
  test("the workflow file exists and parses as YAML", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
    parsedWorkflow();
  });

  test("it triggers on push and pull_request", () => {
    const workflow = parsedWorkflow();
    // YAML 1.1 parsers read the bare `on` key as boolean true; accept either spelling so the assert
    // pins the triggers, not the parser dialect.
    const triggers = (workflow["on"] ?? workflow["true"]) as Record<string, unknown> | undefined;
    expect(triggers).toBeDefined();
    expect(Object.keys(triggers!).sort()).toEqual(["pull_request", "push"]);
  });

  test("it installs dependencies, typechecks, and runs the full suite", () => {
    const commands = runCommands();
    expect(commands.some((command) => command.startsWith("bun install"))).toBe(true);
    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("bun test");
  });
});
