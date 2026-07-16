import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus } from "../corpus";
import { EMBEDDING_DIMENSION } from "../embeddings";
import type { EmbeddingsClient } from "../embeddings";
import { EventWriter, readEvents } from "../events";
import type { StoredEvent } from "../events";
import { initRepo, runGit } from "../git";
import { rebuild } from "../index-db";
import { serializeNote } from "../note";
import type { NoteFrontmatter } from "../note";
import type { StagingDeps } from "../staging";
import { buildPhaseGraph } from "./phase-graph";
import type { PhaseDocument } from "./phase-document";
import { initialRun } from "./reducer";
import type { ExecuteStepDirective, HarvestDirective, RunDefinition } from "./reducer";
import { pendingDirectiveOf } from "./run-events";
import type { ReadableRun } from "./run-events";
import { applyGatedFinalStep, applyHarvest, runEngineSteps } from "./run-executor";

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index++) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const dimension = (hash >>> 0) % EMBEDDING_DIMENSION;
    vector[dimension] = vector[dimension]! + 1;
  }
  return vector;
}

function bagClient(): EmbeddingsClient {
  return {
    embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }),
  };
}

async function buildProjectRepo(): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-executor-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// remember() validates every minted id against the note-id grammar, so the factory must produce
// real ULIDs for any test that stages an artifact.
function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

async function makeDeps(projectRoot: string): Promise<StagingDeps> {
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-executor-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-executor",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  let counter = 0;
  return { corpus, projectRoot, clock: fixedClock, idFactory: () => ulid(counter++), embeddings: bagClient(), eventWriter };
}

const GREEN = [{ kind: "executable" as const, description: "green", command: "true" }];

function phase(id: string, deps: string[] = []): PhaseDocument {
  return {
    id,
    deps,
    agentRole: "coder",
    description: `work on ${id} module ranking probe`,
    tasks: ["do the work"],
    doneWhen: GREEN,
    knowledge: [],
  };
}

function twoPhaseDefinition(): RunDefinition {
  return {
    graph: buildPhaseGraph([phase("phase-one"), phase("phase-two", ["phase-one"])]),
    steps: [{ id: "implement", maxAttempts: 1, onFail: { action: "escalate" } }],
    maxIterations: 20,
  };
}

function activeRunFrom(definition: RunDefinition): ReadableRun {
  return {
    kind: "restored",
    runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    branch: "main",
    definition,
    retrieval: { recallBudget: 2000, recallAnchors: {} },
    run: initialRun(definition),
    startedTs: "2026-07-06T10:00:00.000Z",
    lastFailedGates: null,
  };
}

function recallEventCount(deps: StagingDeps): number {
  return readEvents(deps.corpus.eventsDir).filter(
    (event: StoredEvent) => event.type === "workflow_step_applied" && event.result_kind === "recall",
  ).length;
}

function writeAcceptedNote(deps: StagingDeps, id: string, body: string, commit: string): void {
  const frontmatter: NoteFrontmatter = {
    id,
    type: "decision",
    anchors: ["src/a.ts"],
    commit,
    created: "2026-07-06T10:00:00.000Z",
  };
  writeFileSync(join(deps.corpus.notesDir, `${id}.md`), serializeNote({ frontmatter, body }));
}

async function closePhaseOne(deps: StagingDeps, active: ReadableRun): Promise<void> {
  await runEngineSteps(deps, active); // drains phase-one recall -> execute_step
  const executeStep = pendingDirectiveOf(active);
  if (executeStep.kind !== "execute_step") throw new Error(`expected execute_step, got ${executeStep.kind}`);
  await applyGatedFinalStep(deps, active, executeStep as ExecuteStepDirective, []); // green gate -> harvest
  const harvest = pendingDirectiveOf(active);
  if (harvest.kind !== "harvest") throw new Error(`expected harvest, got ${harvest.kind}`);
  await applyHarvest(deps, active, harvest as HarvestDirective, []); // closes phase-one
}

describe("runEngineSteps executes recall at call entry", () => {
  test("draining a pending recall appends exactly one recall event and yields execute_step", async () => {
    const { projectRoot } = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const active = activeRunFrom(twoPhaseDefinition());

    const sections = await runEngineSteps(deps, active);

    expect(sections.some((section) => section.includes('Recall bundle for phase "phase-one"'))).toBe(true);
    expect(recallEventCount(deps)).toBe(1);
    expect(pendingDirectiveOf(active).kind).toBe("execute_step");
  });
});

describe("applyHarvest defers the next phase's recall (lazy)", () => {
  test("closing a phase leaves the next recall PENDING and emits no recall event for it", async () => {
    const { projectRoot } = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const active = activeRunFrom(twoPhaseDefinition());

    await closePhaseOne(deps, active);

    // Phase two's recall is pending but NOT executed by the harvest: still exactly one recall event.
    const pending = pendingDirectiveOf(active);
    expect(pending.kind).toBe("recall");
    expect(pending.kind === "recall" ? pending.phaseId : "").toBe("phase-two");
    expect(recallEventCount(deps)).toBe(1);

    // The next call executes it: now two recall events and an execute_step for phase two.
    await runEngineSteps(deps, active);
    expect(recallEventCount(deps)).toBe(2);
    const executeStep = pendingDirectiveOf(active);
    expect(executeStep.kind === "execute_step" ? executeStep.phaseId : "").toBe("phase-two");
  });

  test("a note accepted between the boundary and the next call is in phase two's bundle", async () => {
    const { projectRoot, commit } = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const active = activeRunFrom(twoPhaseDefinition());

    await closePhaseOne(deps, active); // phase two's recall is now pending, not yet compiled

    // Simulate a human accepting a note during the boundary pause: it lands in notes/ and the index is
    // rebuilt, exactly as staging_resolve accept does.
    const noteBody = "phase two module ranking closure evidence note";
    writeAcceptedNote(deps, "01ARZ3NDEKTSV4RRFFQ69G5FB0", noteBody, commit);
    await rebuild({
      indexPath: deps.corpus.indexPath,
      notesDir: deps.corpus.notesDir,
      projectRoot,
      embeddings: deps.embeddings,
      eventWriter: deps.eventWriter,
      clock: fixedClock,
    });

    const sections = await runEngineSteps(deps, active); // begins phase two, compiling its bundle now

    const bundle = sections.find((section) => section.includes('Recall bundle for phase "phase-two"'));
    expect(bundle).toBeDefined();
    expect(bundle).toContain(noteBody);
  });
});

describe("applyHarvest dedup visibility", () => {
  test("a duplicate artifact is counted out of harvested_n and named in dedup_rejected", async () => {
    const { projectRoot, commit } = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const active = activeRunFrom(twoPhaseDefinition());
    writeAcceptedNote(
      deps,
      ulid(200),
      "Decision: use sqlite for the index\nRationale: single-file disposable cache",
      commit,
    );
    await rebuild({
      indexPath: deps.corpus.indexPath,
      notesDir: deps.corpus.notesDir,
      projectRoot,
      embeddings: deps.embeddings,
      eventWriter: deps.eventWriter,
      clock: fixedClock,
    });
    await runEngineSteps(deps, active);
    const executeStep = pendingDirectiveOf(active);
    if (executeStep.kind !== "execute_step") throw new Error(`expected execute_step, got ${executeStep.kind}`);
    await applyGatedFinalStep(deps, active, executeStep as ExecuteStepDirective, []);
    const harvest = pendingDirectiveOf(active);
    if (harvest.kind !== "harvest") throw new Error(`expected harvest, got ${harvest.kind}`);

    const sections = await applyHarvest(deps, active, harvest as HarvestDirective, [
      {
        kind: "decision",
        decision: "use sqlite for the index",
        rationale: "single-file disposable cache",
        anchors: ["src/a.ts"],
      },
      {
        kind: "decision",
        decision: "keep flat files as the corpus truth",
        rationale: "the index is a disposable cache",
        anchors: ["src/a.ts"],
      },
    ]);

    expect(sections[0]).toContain('Harvested 1 artifact(s) for phase "phase-one"');
    expect(sections[0]).toContain("1 artifact(s) were dropped as duplicates");
    const harvestEvents = readEvents(deps.corpus.eventsDir).filter(
      (event: StoredEvent) => event.type === "workflow_step_applied" && event.result_kind === "harvest",
    );
    expect(harvestEvents.length).toBe(1);
    expect(harvestEvents[0]!.harvested_n).toBe(1);
    const rejected = harvestEvents[0]!.dedup_rejected as Array<{ nearest_id: string; similarity: number }>;
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.nearest_id).toBe(ulid(200));
    expect(rejected[0]!.similarity).toBeGreaterThan(0.9);
  });

  test("a harvest with no duplicates records an empty rejection list, not silence", async () => {
    const { projectRoot } = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const active = activeRunFrom(twoPhaseDefinition());

    await closePhaseOne(deps, active);

    const harvestEvents = readEvents(deps.corpus.eventsDir).filter(
      (event: StoredEvent) => event.type === "workflow_step_applied" && event.result_kind === "harvest",
    );
    expect(harvestEvents.length).toBe(1);
    expect(harvestEvents[0]!.dedup_rejected).toEqual([]);
    expect(harvestEvents[0]!.harvested_n).toBe(0);
  });
});

describe("applyHarvest on the last phase reaches a terminal, not a boundary", () => {
  test("closing the final phase leaves a run_complete directive, never a pending recall", async () => {
    const { projectRoot } = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const active = activeRunFrom({
      graph: buildPhaseGraph([phase("only-phase")]),
      steps: [{ id: "implement", maxAttempts: 1, onFail: { action: "escalate" } }],
      maxIterations: 20,
    });

    await runEngineSteps(deps, active);
    const executeStep = pendingDirectiveOf(active);
    await applyGatedFinalStep(deps, active, executeStep as ExecuteStepDirective, []);
    const harvest = pendingDirectiveOf(active);
    await applyHarvest(deps, active, harvest as HarvestDirective, []);

    expect(pendingDirectiveOf(active).kind).toBe("run_complete");
    expect(recallEventCount(deps)).toBe(1);
  });
});

describe("the reducer stays memory-agnostic", () => {
  test("reducer.ts imports nothing from the memory subsystem", () => {
    const source = readFileSync(join(import.meta.dir, "reducer.ts"), "utf8");
    const importSources = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
    const forbidden = ["memory-steps", "recall", "staging", "index-db", "corpus", "embeddings", "/events"];
    const leaked = importSources.filter((from) => forbidden.some((needle) => from.includes(needle)));
    expect(leaked).toEqual([]);
  });
});
