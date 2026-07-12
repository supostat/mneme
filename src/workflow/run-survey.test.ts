import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus } from "../corpus";
import { EventWriter, readEvents } from "../events";
import type { StagingDeps } from "../staging";
import type { PhaseDocument } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import type { RunDefinition } from "./reducer";
import { surveySections } from "./run-directives";
import { runStartedPayload } from "./run-payloads";
import { surveyRuns } from "./run-survey";

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
    clock: fixedClock,
    idFactory: () => FOREIGN_RUN_ID,
    embeddings: { embed: async () => ({ available: false, embeddings: [], retries: 0 }) },
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
});
