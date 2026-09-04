import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The gate cannot run GitHub Actions, but it CAN guarantee the workflow exists, parses as YAML,
// carries the steps the local gates mirror, and tags a release only where the design says: after
// the suite, on a push to main, on an unreleased version, and only once a dry-run proved the token
// can write — so CI and the local done-when never drift apart and the tagging path cannot rot.

const WORKFLOW_PATH = join(import.meta.dir, "..", ".github", "workflows", "ci.yml");
const GUARD_STEP_NAME =
  "Verify the release tag can be pushed under RELEASE_TOKEN (a 403 here means the PAT lacks contents:write on this repository or has expired; fix it and re-run this job)";
const TAG_STEP_NAME = "Tag the release";
const FETCH_TAGS_STEP_NAME = "Fetch release tags";
const FETCH_TAGS_COMMAND = "git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*'";
const CREDENTIAL_OVERRIDE = "-c http.https://github.com/.extraheader=";
// The guard and the real tag push. A third push step may be added later and this pin covers it
// automatically, but two is the floor: fewer means the tagging path itself went missing.
const MINIMUM_PUSH_COMMANDS = 2;
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

// Every line of the workflow that invokes `git … push`, wherever it lives. Lines, not whole run
// blocks: the credential override has to sit on the pushing command itself, and a step whose
// FIRST line carried it would otherwise vouch for a second, unprotected push below it.
function pushLines(run: string): string[] {
  return run.split("\n").filter((line) => /^\s*git\b.*\bpush\b/.test(line));
}

function allPushLines(): string[] {
  return runCommands().flatMap(pushLines);
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

  test("release tags are fetched by an explicit git command before the version gate, not by checkout's flag", () => {
    // actions/checkout's fetch-tags did not fetch tags on a depth-1 checkout (run 33860152621), and
    // a gate that sees no tag calls every version unreleased. The workflow owns the fetch itself.
    const checkout = steps().find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toBeDefined();
    expect(checkout!.with?.["fetch-tags"]).toBeUndefined();
    const fetchTags = stepNamed(FETCH_TAGS_STEP_NAME);
    expect(fetchTags.run).toBe(FETCH_TAGS_COMMAND);
    const fetchIndex = indexOfStep((step) => step.name === FETCH_TAGS_STEP_NAME);
    const versionIndex = indexOfStep((step) => step.id === "version");
    expect(fetchIndex).toBeLessThan(versionIndex);
  });

  test("the version step runs the gate in decide mode under the id the tagging steps route on", () => {
    const version = steps().find((step) => step.id === "version");
    expect(version).toBeDefined();
    expect(version!.run).toBe("bun scripts/require-unreleased-version.ts --decide");
    expect(runCommands()).not.toContain("bun scripts/require-unreleased-version.ts");
  });

  test("every push clears the credentials checkout persisted, so the PAT in the URL is the one that authenticates", () => {
    // Without the override git sends checkout's own AUTHORIZATION header and the push runs as
    // github-actions[bot] — run 33886735530 died on exactly that with a 403, while the PAT's
    // permissions were correct. The floor guards against the vacuous reading of "every push":
    // zero pushes would satisfy it silently.
    const pushes = allPushLines();
    expect(pushes.length).toBeGreaterThanOrEqual(MINIMUM_PUSH_COMMANDS);
    for (const push of pushes) {
      expect(push).toContain(CREDENTIAL_OVERRIDE);
    }
  });

  test("the guard dry-runs the tag push under the token, only on an unreleased push to main", () => {
    const guard = stepNamed(GUARD_STEP_NAME);
    expectTaggingConditions(guard);
    expect(guard.env?.["RELEASE_TOKEN"]).toBe("${{ secrets.RELEASE_TOKEN }}");
    expect(guard.env?.["VERSION"]).toBe("${{ steps.version.outputs.version }}");
    expect(guard.run).toContain('git tag "v$VERSION"');
    const [guardPush, ...extraGuardPushes] = pushLines(guard.run!);
    expect(extraGuardPushes).toEqual([]);
    expect(guardPush).toContain("push --dry-run");
    expect(guardPush).toContain("x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}");
  });

  test("the tag step pushes for real under the same conditions and the same token", () => {
    const tag = stepNamed(TAG_STEP_NAME);
    expectTaggingConditions(tag);
    expect(tag.env?.["RELEASE_TOKEN"]).toBe("${{ secrets.RELEASE_TOKEN }}");
    expect(tag.env?.["VERSION"]).toBe("${{ steps.version.outputs.version }}");
    const [tagPush, ...extraTagPushes] = pushLines(tag.run!);
    expect(extraTagPushes).toEqual([]);
    expect(tagPush).not.toContain("--dry-run");
    expect(tagPush).toContain("x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}");
    expect(tagPush).toContain('"v$VERSION"');
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
