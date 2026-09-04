import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The gate cannot run GitHub Actions, but it CAN guarantee the workflow exists, parses as YAML,
// carries the steps the local gates mirror, and tags a release only where the design says: after
// the suite, on a push to main, on an unreleased version, and only once a dry-run proved the token
// can write — so CI and the local done-when never drift apart and the tagging path cannot rot.

const WORKFLOW_PATH = join(import.meta.dir, "..", ".github", "workflows", "ci.yml");
const GUARD_STEP_NAME =
  "Verify RELEASE_TOKEN can push a tag to this repository (widen the PAT to contents:write here and re-run this job)";
const TAG_STEP_NAME = "Tag the release";
const TAGGING_CONDITIONS = [
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main'",
  "steps.version.outputs.unreleased == 'true'",
];

interface Step {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface WorkflowShape {
  jobs?: Record<string, { steps?: Step[] }>;
}

function parsedWorkflow(): Record<string, unknown> {
  const parsed = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

function steps(): Step[] {
  const workflow = parsedWorkflow() as WorkflowShape;
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function runCommands(): string[] {
  return steps().flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
}

function stepNamed(name: string): Step {
  const step = steps().find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step!;
}

function indexOfStep(predicate: (step: Step) => boolean): number {
  const index = steps().findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function expectTaggingConditions(step: Step): void {
  expect(step.if).toBeDefined();
  const conditions = step.if!.split("&&").map((condition) => condition.trim());
  expect(conditions).toEqual(TAGGING_CONDITIONS);
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

  test("checkout fetches tags, otherwise the version gate sees no release and passes vacuously", () => {
    const checkout = steps().find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toBeDefined();
    expect(checkout!.with?.["fetch-tags"]).toBe(true);
  });

  test("the version step runs the gate in decide mode under the id the tagging steps route on", () => {
    const version = steps().find((step) => step.id === "version");
    expect(version).toBeDefined();
    expect(version!.run).toBe("bun scripts/require-unreleased-version.ts --decide");
    expect(runCommands()).not.toContain("bun scripts/require-unreleased-version.ts");
  });

  test("the guard dry-runs the tag push under the token, only on an unreleased push to main", () => {
    const guard = stepNamed(GUARD_STEP_NAME);
    expectTaggingConditions(guard);
    expect(guard.env?.["RELEASE_TOKEN"]).toBe("${{ secrets.RELEASE_TOKEN }}");
    expect(guard.env?.["VERSION"]).toBe("${{ steps.version.outputs.version }}");
    expect(guard.run).toContain('git tag "v$VERSION"');
    expect(guard.run).toContain("git push --dry-run");
    expect(guard.run).toContain("x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}");
  });

  test("the tag step pushes for real under the same conditions and the same token", () => {
    const tag = stepNamed(TAG_STEP_NAME);
    expectTaggingConditions(tag);
    expect(tag.env?.["RELEASE_TOKEN"]).toBe("${{ secrets.RELEASE_TOKEN }}");
    expect(tag.env?.["VERSION"]).toBe("${{ steps.version.outputs.version }}");
    expect(tag.run).toContain("git push ");
    expect(tag.run).not.toContain("--dry-run");
    expect(tag.run).toContain("x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}");
    expect(tag.run).toContain('"v$VERSION"');
  });

  test("the suite runs before the guard, and the guard before the tag push", () => {
    const suite = indexOfStep((step) => step.run === "bun test");
    const guard = indexOfStep((step) => step.name === GUARD_STEP_NAME);
    const tag = indexOfStep((step) => step.name === TAG_STEP_NAME);
    expect(suite).toBeLessThan(guard);
    expect(guard).toBeLessThan(tag);
  });

  test("the only secret the workflow touches is RELEASE_TOKEN", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const secretReferences = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(secretReferences.length).toBeGreaterThan(0);
    expect(new Set(secretReferences)).toEqual(new Set(["RELEASE_TOKEN"]));
  });
});
