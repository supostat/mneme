import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { resolveCorpus } from "../corpus";
import { EventWriter, readEvents } from "../events";
import { initRepo, runGit } from "../git";
import type { StagingDeps } from "../staging";
import type { PhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import type { RunDefinition } from "./reducer";
import { surveySections } from "./run-directives";
import { runAbandonedPayload, runStartedPayload } from "./run-payloads";
import { commitStaleMarks, inspectRuns, surveyRuns } from "./run-survey";
import { EMBEDDING_MODEL } from "../embeddings";

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");
const FOREIGN_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

function makeDefinition(): RunDefinition {
  const phase: PhaseDocument = {
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "Work on phase-one",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "tests pass", command: "true" }],
    knowledge: [],
  };
  return {
    graph: buildPhaseGraph([phase]),
    steps: [{ id: "implement", maxAttempts: 1, onFail: { action: "escalate" } }],
    maxIterations: 10,
  };
}

// projectRoot is deliberately NOT a git repository: every branchExists question is unanswerable,
// so the survey must warn about foreign-branch runs instead of marking them stale.
async function makeNonRepoDeps(): Promise<StagingDeps> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-survey-norepo-"));
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-survey-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome });
  return {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => FOREIGN_RUN_ID,
    embeddings: { model: EMBEDDING_MODEL, embed: async () => ({ available: false, embeddings: [], retries: 0 }) },
    eventWriter: new EventWriter(corpus.eventsDir, { sessionId: "s-survey", clock: fixedClock, mnemeVersion: "0.1.0" }),
  };
}

describe("surveyRuns with unanswerable branch questions", () => {
  test("a foreign-branch run is warned about as indeterminate and NEVER marked stale", async () => {
    const deps = await makeNonRepoDeps();
    deps.eventWriter.append({
      ...runStartedPayload(FOREIGN_RUN_ID, "feature", makeDefinition(), { recallBudget: 2000, recallAnchors: {} }),
      type: "workflow_run_started",
    });

    const survey = await surveyRuns(deps, "main");

    expect(survey.indeterminateRuns.map((run) => run.runId)).toEqual([FOREIGN_RUN_ID]);
    expect(survey.markedStale).toEqual([]);
    expect(survey.pausedRuns).toEqual([]);
    const staleEvents = readEvents(deps.corpus.eventsDir).filter(
      (event) => event.type === "workflow_run_marked_stale",
    );
    expect(staleEvents).toEqual([]);
    const sections = surveySections(survey).join("\n\n");
    expect(sections).toContain(
      `WARNING: could not verify that branch "feature" (run ${FOREIGN_RUN_ID}) still exists`,
    );
    expect(sections).not.toContain("STALE RUNS");
  });

  test("an abandoned run leaves every live listing before the orphan scan", async () => {
    const deps = await makeNonRepoDeps();
    deps.eventWriter.append({
      ...runStartedPayload(FOREIGN_RUN_ID, "feature", makeDefinition(), { recallBudget: 2000, recallAnchors: {} }),
      type: "workflow_run_started",
    });
    deps.eventWriter.append({
      ...runAbandonedPayload(FOREIGN_RUN_ID, "feature", "spec rescoped"),
      type: "workflow_run_abandoned",
    });

    const survey = await surveyRuns(deps, "main");

    // Without the marker this foreign-branch run would surface as indeterminate (the projectRoot
    // cannot answer branch questions); abandoned, it is terminal and never branch-checked at all.
    expect(survey.activeRun).toBeNull();
    expect(survey.indeterminateRuns).toEqual([]);
    expect(survey.pausedRuns).toEqual([]);
    expect(survey.markedStale).toEqual([]);
    expect(surveySections(survey)).toEqual([]);
  });
});

// projectRoot IS a git repository whose "feature" branch existed and was deleted: branchExists
// answers "missing" with proof, which is the only verdict that may ever produce a stale mark.
async function makeDeletedBranchDeps(): Promise<StagingDeps> {
  const deps = await makeNonRepoDeps();
  await initRepo(deps.projectRoot);
  await runGit(deps.projectRoot, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
  await runGit(deps.projectRoot, ["branch", "feature"]);
  await runGit(deps.projectRoot, ["branch", "-D", "feature"]);
  deps.eventWriter.append({
    ...runStartedPayload(FOREIGN_RUN_ID, "feature", makeDefinition(), { recallBudget: 2000, recallAnchors: {} }),
    type: "workflow_run_started",
  });
  return deps;
}

function staleEventsOf(deps: StagingDeps) {
  return readEvents(deps.corpus.eventsDir).filter((event) => event.type === "workflow_run_marked_stale");
}

describe("inspectRuns reads, surveyRuns marks", () => {
  test("inspectRuns surfaces a proven orphan as a candidate and appends NOTHING", async () => {
    const deps = await makeDeletedBranchDeps();
    const eventsBefore = readEvents(deps.corpus.eventsDir).length;

    const survey = await inspectRuns(deps, "main");

    expect(survey.orphanCandidates).toEqual([{ runId: FOREIGN_RUN_ID, branch: "feature" }]);
    expect(survey.markedStale).toEqual([]);
    expect(survey.pausedRuns).toEqual([]);
    expect(survey.indeterminateRuns).toEqual([]);
    expect(readEvents(deps.corpus.eventsDir).length).toBe(eventsBefore);
    expect(staleEventsOf(deps)).toEqual([]);
  });

  test("surveyRuns marks the orphan exactly once and a repeat survey adds no second mark", async () => {
    const deps = await makeDeletedBranchDeps();

    const first = await surveyRuns(deps, "main");
    const second = await surveyRuns(deps, "main");

    expect(first.markedStale).toEqual([{ runId: FOREIGN_RUN_ID, branch: "feature" }]);
    expect(first.orphanCandidates).toEqual([]);
    expect(second.markedStale).toEqual([]);
    expect(second.orphanCandidates).toEqual([]);
    expect(staleEventsOf(deps).map((event) => event.run_id)).toEqual([FOREIGN_RUN_ID]);
    expect(surveySections(first).join("\n\n")).toContain("STALE RUNS");
  });

  test("commitStaleMarks writes one marker per candidate and echoes the marks it wrote", async () => {
    const deps = await makeDeletedBranchDeps();

    const written = commitStaleMarks(deps, [{ runId: FOREIGN_RUN_ID, branch: "feature" }]);

    expect(written).toEqual([{ runId: FOREIGN_RUN_ID, branch: "feature" }]);
    expect(staleEventsOf(deps).map((event) => event.branch)).toEqual(["feature"]);
    expect((await inspectRuns(deps, "main")).orphanCandidates).toEqual([]);
  });
});
