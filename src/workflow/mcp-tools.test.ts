import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../corpus";
import { EMBEDDING_DIMENSION } from "../embeddings";
import type { EmbeddingsClient } from "../embeddings";
import { eventSchema } from "../event-schema";
import { EventWriter, readEvents } from "../events";
import type { StoredEvent } from "../events";
import { initRepo, runGit } from "../git";
import { createServer } from "../mcp-server";
import type { CreateServerOptions } from "../mcp-server";
import type { SubmittedStepResult } from "./mcp-tools";
import { parsePhaseDocument, serializePhaseDocument } from "./phase-document";
import type { DoneWhenCriterion } from "./phase-document";
import { buildPhaseGraph } from "./phase-graph";
import type { RunDefinition } from "./reducer";
import { runStartedPayload } from "./run-payloads";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(): () => string {
  let counter = 0;
  return () => ulid(counter++);
}

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
  return { embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

async function buildProjectRepo(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-wf-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((part) => part.text).join("\n");
}

interface Workbench {
  projectRoot: string;
  corpusHome: string;
  idFactory: () => string;
  client: Client;
}

// One idFactory is shared by every connect of a workbench so a second session can never re-mint an
// existing run id (which would corrupt the log with a duplicate started event).
async function makeWorkbench(embeddings: EmbeddingsClient = bagClient()): Promise<Workbench> {
  const projectRoot = await buildProjectRepo();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-wf-home-"));
  const idFactory = sequentialIds();
  const client = await connect({ projectRoot, corpusHome, embeddings, idFactory, clock: fixedClock });
  return { projectRoot, corpusHome, idFactory, client };
}

async function reconnect(bench: Workbench): Promise<Client> {
  return connect({
    projectRoot: bench.projectRoot,
    corpusHome: bench.corpusHome,
    embeddings: bagClient(),
    idFactory: bench.idFactory,
    clock: fixedClock,
  });
}

async function loggedEvents(bench: Workbench): Promise<StoredEvent[]> {
  const corpus = await resolveCorpus(bench.projectRoot, { corpusHome: bench.corpusHome });
  return readEvents(corpus.eventsDir);
}

// Writes straight into the workbench log, bypassing the tools: anomaly fixtures (duplicate or
// corrupt started events) cannot be constructed through the tool surface by design.
async function workbenchEventWriter(bench: Workbench): Promise<EventWriter> {
  const corpus = await resolveCorpus(bench.projectRoot, { corpusHome: bench.corpusHome });
  return new EventWriter(corpus.eventsDir, { sessionId: "seeded", clock: fixedClock, mnemeVersion: "0.0.0" });
}

function seededDefinition(phaseId: string): RunDefinition {
  return {
    graph: buildPhaseGraph([parsePhaseDocument(phaseText(phaseId))]),
    steps: [{ id: "implement", maxAttempts: 1, onFail: { action: "escalate" } }],
    maxIterations: 10,
  };
}

function eventsOfType(events: StoredEvent[], type: string): StoredEvent[] {
  return events.filter((event) => event.type === type);
}

const GREEN_GATE: DoneWhenCriterion[] = [{ kind: "executable", description: "always green", command: "true" }];
const RED_GATE: DoneWhenCriterion[] = [{ kind: "executable", description: "always red", command: "false" }];
const JUDGED_GATE: DoneWhenCriterion[] = [{ kind: "agent-judged", description: "review approves" }];

function phaseText(id: string, options: { deps?: string[]; doneWhen?: DoneWhenCriterion[] } = {}): string {
  return serializePhaseDocument({
    id,
    deps: options.deps ?? [],
    agentRole: "coder",
    description: `Work on ${id}`,
    tasks: ["do the work"],
    doneWhen: options.doneWhen ?? GREEN_GATE,
  });
}

const SINGLE_STEP = [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }];
const RETRYING_STEP = [{ id: "implement", max_attempts: 2, on_fail: { action: "escalate" } }];
const TWO_STEPS = [
  { id: "implement", max_attempts: 1, on_fail: { action: "escalate" } },
  { id: "verify", max_attempts: 1, on_fail: { action: "escalate" } },
];

function startArgs(phases: string[], steps: unknown[] = SINGLE_STEP): Record<string, unknown> {
  return { phases, steps, max_iterations: 10 };
}

async function startRun(client: Client, args: Record<string, unknown>): Promise<string> {
  const text = await callText(client, "workflow_start", args);
  const match = text.match(/Started workflow run (\S+) on branch/);
  if (match === null) throw new Error(`workflow_start did not report a run id:\n${text}`);
  return match[1]!;
}

function stepResult(
  phaseId: string,
  stepId: string,
  attempt: number,
  outcome: "success" | "failure",
): SubmittedStepResult {
  return { phase_id: phaseId, step_id: stepId, attempt, outcome };
}

describe("workflow full run", () => {
  test("start -> recall -> two steps -> gates PASS -> harvest -> complete, with a v4-clean log", async () => {
    const bench = await makeWorkbench();
    // Asymmetric on purpose (2 executable, 1 agent-judged): a swapped executable_n/agent_judged_n
    // would go unnoticed with one of each.
    const gates: DoneWhenCriterion[] = [
      ...GREEN_GATE,
      { kind: "executable", description: "also green", command: "true" },
      ...JUDGED_GATE,
    ];
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one", { doneWhen: gates })], TWO_STEPS));

    const opened = await callText(bench.client, "workflow_step", {});
    expect(opened).toContain('Recall bundle for phase "phase-one"');
    expect(opened).toContain("DIRECTIVE: execute_step");
    expect(opened).toContain("step: implement");
    expect(opened).toContain("attempt: 1");

    const afterFirst = await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
    });
    expect(afterFirst).toContain("gates were not run");
    expect(afterFirst).toContain("step: verify");
    expect(afterFirst).toContain("FINAL step");
    expect(afterFirst).toContain("[executable] always green (command: true)");
    expect(afterFirst).toContain("[agent-judged] review approves");
    expect(afterFirst).toContain("exactly 1 non-empty array(s)");

    const afterFinal = await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "verify", 1, "success"),
      agent_votes: [["pass"]],
    });
    expect(afterFinal).toContain("Gate verdict for phase-one/verify (attempt 1): PASS");
    expect(afterFinal).toContain("DIRECTIVE: harvest");

    const completed = await callText(bench.client, "workflow_step", {
      run_id: runId,
      harvest_artifacts: [
        { kind: "decision", decision: "use the event log", rationale: "single source of truth", anchors: ["src/a.ts"] },
      ],
    });
    expect(completed).toContain('Harvested 1 artifact(s) for phase "phase-one"');
    expect(completed).toContain("RUN COMPLETE");

    const events = await loggedEvents(bench);
    const harvested = eventsOfType(events, "remember");
    expect(harvested.length).toBe(1);
    expect(harvested[0]!.source).toBe("harvest");
    expect(
      eventsOfType(events, "workflow_step_applied").map((event) => event.result_kind),
    ).toEqual(["recall", "execute_step", "execute_step", "harvest"]);
    const finalApplied = eventsOfType(events, "workflow_step_applied").find((event) => event.step_id === "verify");
    expect(finalApplied?.gates).toEqual({
      passed: true,
      executable_n: 2,
      agent_judged_n: 1,
      criteria: [
        { kind: "executable", description: "always green", passed: true, reason: "exit-zero" },
        { kind: "executable", description: "also green", passed: true, reason: "exit-zero" },
        { kind: "agent-judged", description: "review approves", passed: true, reason: null },
      ],
    });
    for (const event of events) {
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error(`event ${String(event.type)} failed schema: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });
});

describe("workflow interrupt and resume", () => {
  test("a second session re-issues the same directive without re-running recall", async () => {
    const bench = await makeWorkbench();
    await startRun(bench.client, startArgs([phaseText("phase-one")], TWO_STEPS));
    const opened = await callText(bench.client, "workflow_step", {});
    expect(opened).toContain("step: implement");

    const resumed = await callText(await reconnect(bench), "workflow_step", {});

    expect(resumed).toContain("DIRECTIVE: execute_step");
    expect(resumed).toContain("step: implement");
    expect(resumed).toContain("attempt: 1");
    const events = await loggedEvents(bench);
    const recalls = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "recall");
    expect(recalls.length).toBe(1);
  });

  test("a resumed session carries the phase intent and tasks without re-supplying the phase document", async () => {
    const bench = await makeWorkbench();
    // The first session supplies the phase document to workflow_start; the resuming session never
    // does. The interrupted work must survive purely through the event log — otherwise the resumed
    // agent would have to re-read the phase file, the session-state dependency this field removes.
    await startRun(bench.client, startArgs([phaseText("phase-one")]));
    await callText(bench.client, "workflow_step", {});

    const resumed = await callText(await reconnect(bench), "workflow_step", {});

    expect(resumed).toContain("DIRECTIVE: execute_step");
    expect(resumed).toContain("intent:");
    expect(resumed).toContain("Work on phase-one");
    expect(resumed).toContain("tasks:");
    expect(resumed).toContain("- do the work");
  });

  test("a multi-phase run resumes into phase two after phase one closes", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(
      bench.client,
      startArgs([phaseText("phase-one"), phaseText("phase-two", { deps: ["phase-one"] })]),
    );
    await callText(bench.client, "workflow_step", {});
    await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
    });
    const closed = await callText(bench.client, "workflow_step", { run_id: runId, harvest_artifacts: [] });
    expect(closed).toContain('Recall bundle for phase "phase-two"');
    expect(closed).toContain("phase: phase-two");

    const resumed = await callText(await reconnect(bench), "workflow_step", {});

    expect(resumed).toContain("phase: phase-two");
    expect(resumed).toContain("step: implement");
    expect(resumed).toContain("attempt: 1");
    const events = await loggedEvents(bench);
    const recalls = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "recall");
    expect(recalls.length).toBe(2);
  });

  test("interrupted after a failed attempt, the run resumes at attempt 2, later at verify, and completes", async () => {
    const bench = await makeWorkbench();
    const retryingTwoSteps = [
      { id: "implement", max_attempts: 2, on_fail: { action: "escalate" } },
      { id: "verify", max_attempts: 1, on_fail: { action: "escalate" } },
    ];
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")], retryingTwoSteps));
    await callText(bench.client, "workflow_step", {});
    await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "failure"),
    });

    const secondSession = await reconnect(bench);
    const resumedMidRetry = await callText(secondSession, "workflow_step", {});
    expect(resumedMidRetry).toContain("DIRECTIVE: execute_step");
    expect(resumedMidRetry).toContain("step: implement");
    expect(resumedMidRetry).toContain("attempt: 2");
    await callText(secondSession, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 2, "success"),
    });

    const thirdSession = await reconnect(bench);
    const resumedMidPhase = await callText(thirdSession, "workflow_step", {});
    expect(resumedMidPhase).toContain("step: verify");
    expect(resumedMidPhase).toContain("attempt: 1");
    await callText(thirdSession, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "verify", 1, "success"),
    });
    const completed = await callText(thirdSession, "workflow_step", { run_id: runId, harvest_artifacts: [] });
    expect(completed).toContain("RUN COMPLETE");

    const events = await loggedEvents(bench);
    const recalls = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "recall");
    expect(recalls.length).toBe(1);
    const applied = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "execute_step");
    expect(applied.map((event) => [event.step_id, event.attempt, event.outcome])).toEqual([
      ["implement", 1, "failure"],
      ["implement", 2, "success"],
      ["verify", 1, "success"],
    ]);
  });
});

describe("workflow branch scoping", () => {
  test("runs never mix across branches and resume follows the checked-out branch", async () => {
    const bench = await makeWorkbench();
    const mainRunId = await startRun(bench.client, startArgs([phaseText("main-phase")], TWO_STEPS));
    await callText(bench.client, "workflow_step", {});

    await runGit(bench.projectRoot, ["checkout", "-q", "-b", "feature"]);
    const onFeature = await callText(bench.client, "workflow_step", {});
    expect(onFeature).toContain('No unfinished workflow run on branch "feature"');
    expect(onFeature).toContain("Paused runs on other branches:");
    expect(onFeature).toContain(mainRunId);
    expect(onFeature).toContain('[branch "main"]');

    const featureRunId = await startRun(bench.client, startArgs([phaseText("feature-phase")], TWO_STEPS));
    const featureDirective = await callText(bench.client, "workflow_step", {});
    expect(featureDirective).toContain(featureRunId);
    expect(featureDirective).toContain("phase: feature-phase");
    await callText(bench.client, "workflow_step", {
      run_id: featureRunId,
      step_result: stepResult("feature-phase", "implement", 1, "success"),
    });

    await runGit(bench.projectRoot, ["checkout", "-q", "main"]);
    const backOnMain = await callText(bench.client, "workflow_step", {});

    expect(backOnMain).toContain(`Workflow run ${mainRunId}`);
    expect(backOnMain).toContain("phase: main-phase");
    expect(backOnMain).toContain("step: implement");
    expect(backOnMain).toContain("attempt: 1");
  });
});

describe("workflow idempotency", () => {
  test("a repeated submission is a no-op reissue and appends no second event", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")], TWO_STEPS));
    await callText(bench.client, "workflow_step", {});
    const submission = { run_id: runId, step_result: stepResult("phase-one", "implement", 1, "success") };
    await callText(bench.client, "workflow_step", submission);

    const repeated = await callText(bench.client, "workflow_step", submission);

    expect(repeated).toContain("NOTICE: the submission does not match the pending directive");
    expect(repeated).toContain("step: verify");
    const events = await loggedEvents(bench);
    const applied = eventsOfType(events, "workflow_step_applied").filter((event) => event.step_id === "implement");
    expect(applied.length).toBe(1);
  });

  test("workflow_start over a live run returns its id with an explicit ignored-definition notice", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")]));

    const second = await callText(bench.client, "workflow_start", startArgs([phaseText("phase-two")]));

    expect(second).toContain(`an unfinished workflow run already exists on this branch: ${runId}`);
    expect(second).toContain("The submitted definition was IGNORED.");
    const events = await loggedEvents(bench);
    expect(eventsOfType(events, "workflow_run_started").length).toBe(1);
  });
});

describe("workflow gates", () => {
  test("a red executable gate fails the final step and escalation frees the branch for a new start", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one", { doneWhen: RED_GATE })]));
    await callText(bench.client, "workflow_step", {});

    const escalated = await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
    });

    expect(escalated).toContain("Gate verdict for phase-one/implement (attempt 1): FAIL");
    expect(escalated).toContain("FAIL always red [exit-nonzero]");
    expect(escalated).toContain("RUN ESCALATED at phase-one/implement: retry_budget_exhausted");
    const events = await loggedEvents(bench);
    const applied = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "execute_step");
    expect(applied.length).toBe(1);
    expect(applied[0]!.outcome).toBe("failure");
    expect((applied[0]!.gates as { passed: boolean }).passed).toBe(false);

    const restarted = await startRun(bench.client, startArgs([phaseText("phase-one")]));
    expect(restarted).not.toBe(runId);
  });

  test("a failure submission of the final step never runs gates even when the command is green", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")], RETRYING_STEP));
    await callText(bench.client, "workflow_step", {});

    const afterFailure = await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "failure"),
    });

    expect(afterFailure).toContain("gates were not run");
    expect(afterFailure).not.toContain("Gate verdict");
    expect(afterFailure).toContain("attempt: 2");
    const events = await loggedEvents(bench);
    const applied = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "execute_step");
    expect(applied.length).toBe(1);
    expect(applied[0]!.outcome).toBe("failure");
    expect(applied[0]!.gates).toBeNull();
  });

  test("an agent-judged pass verdict opens harvest", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one", { doneWhen: JUDGED_GATE })]));
    await callText(bench.client, "workflow_step", {});

    const passed = await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
      agent_votes: [["pass"]],
    });

    expect(passed).toContain("Gate verdict for phase-one/implement (attempt 1): PASS");
    expect(passed).toContain("DIRECTIVE: harvest");
  });

  test("an agent-judged fail verdict fails the step and the reducer retries", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(
      bench.client,
      startArgs([phaseText("phase-one", { doneWhen: JUDGED_GATE })], RETRYING_STEP),
    );
    await callText(bench.client, "workflow_step", {});

    const failed = await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
      agent_votes: [["fail"]],
    });

    expect(failed).toContain("Gate verdict for phase-one/implement (attempt 1): FAIL");
    expect(failed).toContain("attempt: 2");
  });

  test("an empty harvest_artifacts array still closes the phase", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")]));
    await callText(bench.client, "workflow_step", {});
    await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
    });

    const completed = await callText(bench.client, "workflow_step", { run_id: runId, harvest_artifacts: [] });

    expect(completed).toContain('Harvested 0 artifact(s) for phase "phase-one"');
    expect(completed).toContain("RUN COMPLETE");
    const events = await loggedEvents(bench);
    const harvests = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "harvest");
    expect(harvests.length).toBe(1);
    expect(harvests[0]!.harvested_n).toBe(0);
  });
});

describe("workflow log anomaly surfacing", () => {
  const SEEDED_RETRIEVAL = { recallBudget: 2000, recallAnchors: {} };

  test("two started events on one branch sync to the newest run and name the superseded one", async () => {
    const bench = await makeWorkbench();
    const writer = await workbenchEventWriter(bench);
    writer.append({
      ...runStartedPayload(ulid(80), "main", seededDefinition("phase-one"), SEEDED_RETRIEVAL),
      type: "workflow_run_started",
    });
    writer.append({
      ...runStartedPayload(ulid(81), "main", seededDefinition("phase-one"), SEEDED_RETRIEVAL),
      type: "workflow_run_started",
    });

    const synced = await callText(bench.client, "workflow_step", {});

    expect(synced).toContain(`Workflow run ${ulid(81)} [branch "main"]`);
    expect(synced).toContain("LOG ANOMALIES:");
    expect(synced).toContain(
      `multiple running runs on branch "main": run ${ulid(80)} is superseded by the newest started run`,
    );
  });

  test("a corrupt started event surfaces as an unreadable-run notice on sync", async () => {
    const bench = await makeWorkbench();
    const writer = await workbenchEventWriter(bench);
    writer.append({ type: "workflow_run_started", run_id: ulid(70), branch: "main", definition: 7 });

    const synced = await callText(bench.client, "workflow_step", {});

    expect(synced).toContain("LOG ANOMALIES:");
    expect(synced).toContain(
      `run ${ulid(70)} [branch "main"] is unreadable and will not be resumed: workflow_run_started failed schema validation`,
    );
  });

  test("an unreadable run with control-char id and separator branch renders stripped, never raw", async () => {
    const bench = await makeWorkbench();
    const writer = await workbenchEventWriter(bench);
    const bell = String.fromCodePoint(0x0007);
    const lineSeparator = String.fromCodePoint(0x2028);
    writer.append({
      type: "workflow_run_started",
      run_id: `${ulid(71)}${bell}`,
      branch: `main${lineSeparator}injected`,
      definition: 7,
    });

    const synced = await callText(bench.client, "workflow_step", {});

    expect(synced).toContain("LOG ANOMALIES:");
    expect(synced).toContain(`run ${ulid(71)} [branch "maininjected"] is unreadable`);
    expect(synced).toContain("ULID/UUID id grammar");
    expect(synced).not.toContain(bell);
    expect(synced).not.toContain(lineSeparator);
  });

  test("a ghost step_applied with a hostile run_id is unreadable and never echoed raw", async () => {
    const bench = await makeWorkbench();
    const writer = await workbenchEventWriter(bench);
    const paragraphSeparator = String.fromCodePoint(0x2029);
    writer.append({
      type: "workflow_step_applied",
      run_id: `ghost${paragraphSeparator}run`,
      branch: "main",
      phase_id: "phase-one",
      result_kind: "recall",
      step_id: null,
      outcome: null,
      attempt: null,
      gates: null,
      harvested_n: null,
    });

    const synced = await callText(bench.client, "workflow_step", {});

    expect(synced).toContain("LOG ANOMALIES:");
    expect(synced).toContain('run ghostrun [branch "main"] is unreadable');
    expect(synced).toContain("ULID/UUID id grammar");
    expect(synced).not.toContain(paragraphSeparator);
  });
});

describe("workflow recall retrieval", () => {
  test("recall_anchors and recall_budget for a phase flow into the recall event", async () => {
    const bench = await makeWorkbench();
    await startRun(bench.client, {
      ...startArgs([phaseText("phase-one")]),
      recall_budget: 123,
      recall_anchors: { "phase-one": ["src/a.ts"] },
    });

    const opened = await callText(bench.client, "workflow_step", {});

    expect(opened).toContain('Recall bundle for phase "phase-one"');
    const recallEvents = eventsOfType(await loggedEvents(bench), "recall");
    expect(recallEvents.length).toBe(1);
    expect(String(recallEvents[0]!.query)).toContain("src/a.ts");
    expect(recallEvents[0]!.budget).toBe(123);
  });
});

describe("workflow terminal sync", () => {
  test("a sync after RUN COMPLETE reports the last terminal run", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")]));
    await callText(bench.client, "workflow_step", {});
    await callText(bench.client, "workflow_step", {
      run_id: runId,
      step_result: stepResult("phase-one", "implement", 1, "success"),
    });
    await callText(bench.client, "workflow_step", { run_id: runId, harvest_artifacts: [] });

    const synced = await callText(bench.client, "workflow_step", {});

    expect(synced).toContain('No unfinished workflow run on branch "main"');
    expect(synced).toContain(`Last terminal run on this branch: ${runId} [complete]`);
    expect(synced).toContain("Terminal runs are never resumed");
  });
});

describe("workflow orphan handling", () => {
  test("a deleted branch marks its run stale exactly once and a recreated branch never resumes it", async () => {
    const bench = await makeWorkbench();
    await runGit(bench.projectRoot, ["checkout", "-q", "-b", "feature"]);
    const featureRunId = await startRun(bench.client, startArgs([phaseText("phase-one")]));
    await runGit(bench.projectRoot, ["checkout", "-q", "main"]);
    await runGit(bench.projectRoot, ["branch", "-q", "-D", "feature"]);

    const marked = await callText(bench.client, "workflow_step", {});
    expect(marked).toContain("STALE RUNS (branch not found):");
    expect(marked).toContain(featureRunId);
    expect(eventsOfType(await loggedEvents(bench), "workflow_run_marked_stale").length).toBe(1);

    const repeated = await callText(bench.client, "workflow_step", {});
    expect(repeated).not.toContain("STALE RUNS");
    expect(eventsOfType(await loggedEvents(bench), "workflow_run_marked_stale").length).toBe(1);

    await runGit(bench.projectRoot, ["checkout", "-q", "-b", "feature"]);
    const recreated = await callText(bench.client, "workflow_step", {});
    expect(recreated).toContain('No unfinished workflow run on branch "feature"');
    expect(recreated).toContain(`Run ${featureRunId} on this branch was marked stale`);
    expect(recreated).not.toContain("DIRECTIVE:");
  });

  test("a detached HEAD sync is informational and marks nothing; a submit is an error", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")]));
    await runGit(bench.projectRoot, ["checkout", "-q", "--detach"]);

    const synced = await bench.client.callTool({ name: "workflow_step", arguments: {} });
    expect(synced.isError).toBeUndefined();
    const syncedText = (synced.content as Array<{ text: string }>).map((part) => part.text).join("\n");
    expect(syncedText).toContain("HEAD is detached");
    expect(eventsOfType(await loggedEvents(bench), "workflow_run_marked_stale").length).toBe(0);

    const submitted = await bench.client.callTool({
      name: "workflow_step",
      arguments: { run_id: runId, step_result: stepResult("phase-one", "implement", 1, "success") },
    });
    expect(submitted.isError).toBe(true);
  });

  test("a git failure keeps sync silent in the log and turns a submit into a tool_error", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-wf-norepo-"));
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-wf-home-"));
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: bagClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const synced = await callText(client, "workflow_step", {});
    expect(synced).toContain("git failed to resolve the current branch");
    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    expect(readEvents(corpus.eventsDir).length).toBe(0);

    const submitted = await client.callTool({
      name: "workflow_step",
      arguments: { run_id: ulid(9), step_result: stepResult("phase-one", "implement", 1, "success") },
    });
    expect(submitted.isError).toBe(true);
    const errors = readEvents(corpus.eventsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]!.type).toBe("tool_error");
    expect(errors[0]!.tool).toBe("workflow_step");
  });
});

describe("workflow input validation", () => {
  async function expectStepError(bench: Workbench, args: Record<string, unknown>, fragment: string): Promise<void> {
    const result = await bench.client.callTool({ name: "workflow_step", arguments: args });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain(fragment);
  }

  test("mutually exclusive and incomplete submissions are rejected", async () => {
    const bench = await makeWorkbench();

    await expectStepError(
      bench,
      {
        run_id: ulid(9),
        step_result: stepResult("phase-one", "implement", 1, "success"),
        harvest_artifacts: [],
      },
      "mutually exclusive",
    );
    await expectStepError(bench, { run_id: ulid(9), agent_votes: [["pass"]] }, "only valid alongside step_result");
    await expectStepError(
      bench,
      { step_result: stepResult("phase-one", "implement", 1, "success") },
      "a submission requires run_id",
    );
  });

  test("a submission naming a foreign run_id is rejected without touching the run", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one")], TWO_STEPS));
    await callText(bench.client, "workflow_step", {});

    await expectStepError(
      bench,
      { run_id: ulid(42), step_result: stepResult("phase-one", "implement", 1, "success") },
      `does not name this branch's unfinished run ${runId}`,
    );
    const events = await loggedEvents(bench);
    const applied = eventsOfType(events, "workflow_step_applied").filter((event) => event.result_kind === "execute_step");
    expect(applied.length).toBe(0);
  });

  test("a vote-count mismatch on the gated final step is a loud error", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one", { doneWhen: JUDGED_GATE })]));
    await callText(bench.client, "workflow_step", {});

    await expectStepError(
      bench,
      {
        run_id: runId,
        step_result: stepResult("phase-one", "implement", 1, "success"),
        agent_votes: [["pass"], ["pass"]],
      },
      "expected 1 agent vote arrays, received 2",
    );
  });

  test("agent_votes with a failure submission are rejected because failure never runs gates", async () => {
    const bench = await makeWorkbench();
    const runId = await startRun(bench.client, startArgs([phaseText("phase-one", { doneWhen: JUDGED_GATE })]));
    await callText(bench.client, "workflow_step", {});

    await expectStepError(
      bench,
      {
        run_id: runId,
        step_result: stepResult("phase-one", "implement", 1, "failure"),
        agent_votes: [["pass"]],
      },
      "only accepted with a success submission",
    );
  });

  test("workflow_start rejects a malformed phase text", async () => {
    const bench = await makeWorkbench();

    const result = await bench.client.callTool({
      name: "workflow_start",
      arguments: startArgs(["not a phase document"]),
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("frontmatter");
  });

  test("workflow_start rejects recall_anchors naming an unknown phase", async () => {
    const bench = await makeWorkbench();

    const result = await bench.client.callTool({
      name: "workflow_start",
      arguments: { ...startArgs([phaseText("phase-one")]), recall_anchors: { "ghost-phase": ["src/a.ts"] } },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('unknown phase "ghost-phase"');
  });

  test("workflow_start rejects recall_anchors values that fail the anchor grammar", async () => {
    const bench = await makeWorkbench();

    for (const invalidAnchor of ["../outside/repo.ts", "-rf"]) {
      const result = await bench.client.callTool({
        name: "workflow_start",
        arguments: { ...startArgs([phaseText("phase-one")]), recall_anchors: { "phase-one": [invalidAnchor] } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain('recall_anchors for phase "phase-one"');
    }
    const events = await loggedEvents(bench);
    expect(eventsOfType(events, "workflow_run_started").length).toBe(0);
  });

  test("workflow_start on a detached HEAD is an error", async () => {
    const bench = await makeWorkbench();
    await runGit(bench.projectRoot, ["checkout", "-q", "--detach"]);

    const result = await bench.client.callTool({
      name: "workflow_start",
      arguments: startArgs([phaseText("phase-one")]),
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("detached HEAD");
  });
});
