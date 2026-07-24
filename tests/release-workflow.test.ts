import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The gate cannot run GitHub Actions, but it CAN pin the release pipeline's structure: the tag
// trigger, the test-before-release chain, the commands the jobs run, and the single secret name —
// so the workflow cannot silently rot or grow an unreviewed credential.

const WORKFLOW_PATH = join(import.meta.dir, "..", ".github", "workflows", "release.yml");

interface WorkflowShape {
  jobs?: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string; uses?: string }> }>;
}

function parsedWorkflow(): Record<string, unknown> {
  const parsed = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

function runCommandsOf(jobName: string): string[] {
  const workflow = parsedWorkflow() as WorkflowShape;
  const job = (workflow.jobs ?? {})[jobName];
  expect(job).toBeDefined();
  return (job!.steps ?? []).flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
}

describe("Release workflow", () => {
  test("the workflow file exists and parses as YAML", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
    parsedWorkflow();
  });

  test("it triggers only on v* tag pushes", () => {
    const workflow = parsedWorkflow();
    // YAML 1.1 parsers read the bare `on` key as boolean true; accept either spelling so the assert
    // pins the triggers, not the parser dialect.
    const triggers = (workflow["on"] ?? workflow["true"]) as Record<string, unknown> | undefined;
    expect(triggers).toBeDefined();
    expect(Object.keys(triggers!)).toEqual(["push"]);
    expect((triggers!["push"] as Record<string, unknown>)["tags"]).toEqual(["v*"]);
  });

  test("release runs only after the test job", () => {
    const workflow = parsedWorkflow() as WorkflowShape;
    expect(workflow.jobs?.["release"]?.needs).toBe("test");
  });

  test("the test job mirrors the local gates", () => {
    const commands = runCommandsOf("test");
    expect(commands.some((command) => command.startsWith("bun install"))).toBe(true);
    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("bun test");
  });

  test("the release job builds the matrix, publishes the release, and dispatches the plugin sync", () => {
    const commands = runCommandsOf("release");
    expect(commands.some((command) => command.includes("bun run build-release"))).toBe(true);
    expect(commands.some((command) => command.includes("gh release create"))).toBe(true);
    expect(commands.some((command) => command.includes("dispatches"))).toBe(true);
  });

  test("the published release tag is namespaced so it never collides with plugin v* tags", () => {
    const commands = runCommandsOf("release");
    const publish = commands.find((command) => command.includes("gh release create"));
    expect(publish).toBeDefined();
    expect(publish!).toContain("engine-$GITHUB_REF_NAME");
  });

  test("the only secret the workflow touches is RELEASE_TOKEN", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const secretReferences = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(secretReferences.length).toBeGreaterThan(0);
    expect(new Set(secretReferences)).toEqual(new Set(["RELEASE_TOKEN"]));
  });
});
