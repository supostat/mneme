import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter, readEvents } from "../src/events";
import { initRepo, runGit } from "../src/git";
import type { StagingDeps } from "../src/staging";
import { buildPhaseGraph } from "../src/workflow/phase-graph";
import type { PhaseDocument } from "../src/workflow/phase-document";
import { initialRun } from "../src/workflow/reducer";
import type { ExecuteStepDirective, RunDefinition } from "../src/workflow/reducer";
import { renderCurrentDirective } from "../src/workflow/run-directives";
import { pendingDirectiveOf, restoreRuns } from "../src/workflow/run-events";
import type { ReadableRun } from "../src/workflow/run-events";
import { applyGatedFinalStep, runEngineSteps } from "../src/workflow/run-executor";
import { runStartedPayload } from "../src/workflow/run-payloads";

// The review-collegium loop on REAL modules end-to-end: two agent-judged criteria on different
// axes fail on different attempts, and the attempt-3 retry directive must replay BOTH attempts'
// remarks — the attempt-1 complaint surviving as cured-earlier, do-not-re-break context. The
// trajectory travels applyGatedFinalStep -> event log -> restoreRuns -> renderCurrentDirective;
// the ONLY mock is the embeddings client.

setDefaultTimeout(30_000);

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA7";

const SPEC_AXIS = "the diff matches the spec's semantics";
const STANDARDS_AXIS = "the diff holds the codebase standards";
const SPEC_REMARK = "the history is truncated to the newest record";
const STANDARDS_REMARK = "the helper name abbreviates its subject";

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

function collegiumPhase(): PhaseDocument {
  return {
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "work under the review collegium",
    tasks: ["do the work"],
    doneWhen: [
      { kind: "executable", description: "green stub", command: "true" },
      { kind: "agent-judged", description: SPEC_AXIS },
      { kind: "agent-judged", description: STANDARDS_AXIS },
    ],
    knowledge: [],
  };
}

function definitionWith(maxAttempts: number): RunDefinition {
  return {
    graph: buildPhaseGraph([collegiumPhase()]),
    steps: [{ id: "implement", maxAttempts, onFail: { action: "escalate" } }],
    maxIterations: 20,
  };
}

async function buildFixture(maxAttempts: number): Promise<{ deps: StagingDeps; active: ReadableRun }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-collegium-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-collegium-e2e-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-collegium-e2e",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  const definition = definitionWith(maxAttempts);
  const active: ReadableRun = {
    kind: "restored",
    runId: RUN_ID,
    branch: "main",
    definition,
    retrieval: { recallBudget: 2000, recallAnchors: {} },
    run: initialRun(definition),
    startedTs: "2026-07-06T10:00:00.000Z",
    failedGatesHistory: [],
  };
  const deps: StagingDeps = {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => RUN_ID,
    embeddings: offlineClient(),
    eventWriter,
  };
  deps.eventWriter.append({
    ...runStartedPayload(active.runId, active.branch, definition, active.retrieval),
    type: "workflow_run_started",
  });
  await runEngineSteps(deps, active);
  return { deps, active };
}

function pendingExecuteStep(active: ReadableRun): ExecuteStepDirective {
  const pending = pendingDirectiveOf(active);
  if (pending.kind !== "execute_step") throw new Error(`expected execute_step, got ${pending.kind}`);
  return pending;
}

function reconnectedRun(deps: StagingDeps): ReadableRun {
  const restored = restoreRuns(readEvents(deps.corpus.eventsDir)).find((run) => run.kind === "restored");
  if (restored === undefined || restored.kind !== "restored") throw new Error("expected a restored run");
  return restored;
}

test("the attempt-3 directive replays both failed attempts' remarks, live and after reconnect", async () => {
  const { deps, active } = await buildFixture(3);

  // Attempt 1: the spec axis fails, the standards axis passes.
  const gate1 = await applyGatedFinalStep(deps, active, pendingExecuteStep(active), [
    [{ vote: "fail", remarks: SPEC_REMARK }],
    [{ vote: "pass" }],
  ]);
  expect(gate1[0]).toContain("(attempt 1): FAIL");

  const retry2 = renderCurrentDirective(active, 0);
  expect(retry2).toContain("attempt: 2");
  expect(retry2).toContain("review remarks from failed attempt 1:");
  expect(retry2).toContain(`- [${SPEC_AXIS}] ${SPEC_REMARK}`);

  // Attempt 2: the spec axis is cured, the standards axis fails — the collegium disagrees.
  const gate2 = await applyGatedFinalStep(deps, active, pendingExecuteStep(active), [
    [{ vote: "pass" }],
    [{ vote: "fail", remarks: STANDARDS_REMARK }],
  ]);
  expect(gate2[0]).toContain("(attempt 2): FAIL");

  // The attempt-3 retry carries BOTH remarks: the cured attempt-1 complaint stays visible as
  // do-not-re-break context, ascending by attempt.
  const retry3 = renderCurrentDirective(active, 0);
  expect(retry3).toContain("attempt: 3");
  expect(retry3).toContain("review remarks from failed attempt 1:");
  expect(retry3).toContain(`- [${SPEC_AXIS}] ${SPEC_REMARK}`);
  expect(retry3).toContain("review remarks from failed attempt 2:");
  expect(retry3).toContain(`- [${STANDARDS_AXIS}] ${STANDARDS_REMARK}`);
  expect(retry3.indexOf("failed attempt 1")).toBeLessThan(retry3.indexOf("failed attempt 2"));

  // Reconnect: a fresh session folds the log alone and renders the identical trajectory.
  const restored = reconnectedRun(deps);
  expect(restored.failedGatesHistory).toEqual(active.failedGatesHistory);
  const resumed = renderCurrentDirective(restored, 0);
  expect(resumed).toContain("attempt: 3");
  expect(resumed).toContain(`- [${SPEC_AXIS}] ${SPEC_REMARK}`);
  expect(resumed).toContain(`- [${STANDARDS_AXIS}] ${STANDARDS_REMARK}`);
});

test("failures through max_attempts end in an honest ESCALATED with no remarks rendered after the terminal", async () => {
  const { deps, active } = await buildFixture(2);

  await applyGatedFinalStep(deps, active, pendingExecuteStep(active), [
    [{ vote: "fail", remarks: SPEC_REMARK }],
    [{ vote: "pass" }],
  ]);
  await applyGatedFinalStep(deps, active, pendingExecuteStep(active), [
    [{ vote: "fail", remarks: SPEC_REMARK }],
    [{ vote: "pass" }],
  ]);

  expect(pendingDirectiveOf(active).kind).toBe("escalate");
  const terminal = renderCurrentDirective(active, 0);
  expect(terminal).toContain("RUN ESCALATED at phase-one/implement");
  expect(terminal).not.toContain("review remarks");
});

test("collegium disagreement is a criterion fail: mixed votes on one criterion fail its gate", async () => {
  const { deps, active } = await buildFixture(2);

  // Two reviewers on the SAME criterion disagree — unanimity fails it even though one passed;
  // the spec axis passes cleanly.
  const gate = await applyGatedFinalStep(deps, active, pendingExecuteStep(active), [
    [{ vote: "pass" }],
    [{ vote: "pass" }, { vote: "fail", remarks: STANDARDS_REMARK }],
  ]);

  expect(gate[0]).toContain("(attempt 1): FAIL");
  expect(gate[0]).toContain(`PASS ${SPEC_AXIS}`);
  expect(gate[0]).toContain(`FAIL ${STANDARDS_AXIS}`);
});
