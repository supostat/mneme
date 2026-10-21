import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";
import { INCONCLUSIVE_DIRECTIVE_HEADER } from "../src/workflow/run-directives";

// The wire test of per-criterion gate limits and inconclusive gate runs, end to end on REAL modules:
// a spec whose fence carries timeout=1s is migrated into a phase file, a run starts from that file,
// the gate kills a command that waits on its environment, the attempt survives, a SECOND SESSION
// restores the re-run from the log alone, and once the environment is quiet the same attempt goes
// green. The only stand-in is the embedder, and it is deterministic; the gate command is a real
// spawned process that sleeps while a flag file says the machine is busy.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NOW = new Date("2026-10-21T10:00:00.000Z");
const fixedClock = () => NOW;
const E2E_TIMEOUT_MS = 60000;
const SPEC_PATH = "docs/SPEC-GATE-E2E.md";
const SLOW_FLAG = "slow.flag";
const BUSY_LINE = "gate.ts: warming the build cache";
const CRITERION = "gate script is green (exit 0).";

// writeSync, not console.log: a buffered line could still sit in the process when SIGKILL lands.
const GATE_SCRIPT = [
  'import { existsSync, writeSync } from "node:fs";',
  `if (existsSync("${SLOW_FLAG}")) {`,
  `  writeSync(1, "${BUSY_LINE}\\n");`,
  "  await Bun.sleep(60_000);",
  "}",
  'writeSync(1, "ok\\n");',
  "",
].join("\n");

const SPEC_TEXT = [
  "# Gameplan",
  "",
  "### Phase 1: slow-gate — a gate that waits on its environment",
  "",
  "- [ ] do the work",
  "",
  "**Done when (EXECUTABLE):**",
  "```timeout=1s",
  "bun gate.ts",
  "```",
  `- ${CRITERION}`,
  "",
].join("\n");

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

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
    model: EMBEDDING_MODEL,
    embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }),
  };
}

interface Session {
  client: Client;
  projectRoot: string;
  corpusHome: string;
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// One idFactory per corpus across sessions: a second session that re-minted ids would collide with
// the first session's run id and corrupt the log for the wrong reason.
function sequentialIds(start: number): () => string {
  let counter = start;
  return () => ulid(counter++);
}

async function openSession(projectRoot: string, corpusHome: string, idStart: number): Promise<Session> {
  const client = await connect({
    projectRoot,
    corpusHome,
    embeddings: bagClient(),
    idFactory: sequentialIds(idStart),
    clock: fixedClock,
  });
  return { client, projectRoot, corpusHome };
}

// A busy project: the gate script, the spec that limits it to one second, and the flag that makes it
// wait as if another build held the machine.
async function buildBusyProject(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-gate-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "docs"), { recursive: true });
  writeFileSync(join(projectRoot, "gate.ts"), GATE_SCRIPT);
  writeFileSync(join(projectRoot, SPEC_PATH), SPEC_TEXT);
  writeFileSync(join(projectRoot, SLOW_FLAG), "busy\n");
  await runGit(projectRoot, ["add", "gate.ts"]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

async function callText(session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await session.client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

async function loggedEvents(session: Session): Promise<StoredEvent[]> {
  const corpus = await resolveCorpus(session.projectRoot, { corpusHome: session.corpusHome });
  return readEvents(corpus.eventsDir);
}

async function migratedPhaseText(session: Session): Promise<string> {
  const applied = await callText(session, "workflow_migrate", { spec_path: SPEC_PATH, apply: true });
  const phasePath = /(\S+phase-slow-gate\.md)/.exec(applied)?.[1];
  if (phasePath === undefined) throw new Error(`could not read the phase file path from: ${applied}`);
  return readFileSync(phasePath, "utf8");
}

async function startRun(session: Session, phaseText: string): Promise<string> {
  const started = await callText(session, "workflow_start", {
    phases: [phaseText],
    steps: [{ id: "implement", max_attempts: 2, on_fail: { action: "escalate" } }],
    max_iterations: 10,
  });
  const runId = /Started workflow run ([0-9a-fA-F-]{36}|[0-9A-Z]{26})/.exec(started)?.[1];
  if (runId === undefined) throw new Error(`could not read the run id from: ${started}`);
  return runId;
}

async function submitSuccess(session: Session, runId: string, attempt: number): Promise<string[]> {
  const response = await callText(session, "workflow_step", {
    run_id: runId,
    step_result: { phase_id: "slow-gate", step_id: "implement", attempt, outcome: "success" },
  });
  return response.split("\n");
}

function lastStepApplied(events: StoredEvent[]): StoredEvent {
  const applied = events.filter((event) => event.type === "workflow_step_applied");
  return applied[applied.length - 1]!;
}

describe("a per-criterion gate limit and an inconclusive gate run, end to end", () => {
  test(
    "the limit reaches the gate, a timeout keeps the attempt across sessions, and the quiet re-run goes green",
    async () => {
      const projectRoot = await buildBusyProject();
      const corpusHome = mkdtempSync(join(tmpdir(), "mneme-gate-e2e-home-"));
      const first = await openSession(projectRoot, corpusHome, 1);

      // 1. The fence's limit survives migration into the phase file the run starts from.
      const phaseText = await migratedPhaseText(first);
      expect(phaseText.split("\n")).toContain("```timeout=1s");
      const runId = await startRun(first, phaseText);

      // 2. The agent sees the limit before the gate runs.
      const opened = await callText(first, "workflow_step", {});
      expect(opened.split("\n")).toContain(`- [executable] ${CRITERION} (command: bun gate.ts; limit 1 s)`);

      // 3. The gate kills the waiting command at one second: inconclusive, attempt kept, evidence shown.
      const verdict = await submitSuccess(first, runId, 1);
      expect(verdict).toContain("Gate verdict for slow-gate/implement (attempt 1): INCONCLUSIVE");
      expect(verdict).toContain(
        "Every red criterion timed out, so the attempt was not consumed; environment re-runs left: 1.",
      );
      const timeoutLine = /^FAIL gate script is green \(exit 0\)\. \[timeout · \d+\.\d s, limit 1 s\]$/;
      expect(verdict.some((line) => timeoutLine.test(line))).toBe(true);
      expect(verdict).toContain(`  | ${BUSY_LINE}`);
      expect(verdict).toContain("attempt: 1");
      expect(verdict).toContain(`${INCONCLUSIVE_DIRECTIVE_HEADER}; environment re-runs left: 1.`);

      // 4. The log records the gates' verdict and the numbers, never the output.
      const events = await loggedEvents(first);
      const applied = lastStepApplied(events);
      expect(applied.outcome).toBe("inconclusive");
      expect(applied.attempt).toBe(1);
      const [criterion] = (applied.gates as { criteria: Array<Record<string, unknown>> }).criteria;
      expect(criterion!.timeout_seconds).toBe(1);
      expect(criterion!.duration_ms as number).toBeGreaterThanOrEqual(1000);
      const started = events.find((event) => event.type === "workflow_run_started")!;
      const definition = started.definition as { phases: Array<{ done_when: Array<Record<string, unknown>> }> };
      expect(definition.phases[0]!.done_when[0]!.timeout_seconds).toBe(1);
      expect(JSON.stringify(events)).not.toContain("warming the build cache");

      // 5. A SECOND SESSION restores the re-run from the log alone: same attempt, same explanation.
      const second = await openSession(projectRoot, corpusHome, 500);
      const resumed = (await callText(second, "workflow_step", {})).split("\n");
      expect(resumed).toContain("attempt: 1");
      expect(resumed).toContain(`${INCONCLUSIVE_DIRECTIVE_HEADER}; environment re-runs left: 1.`);
      expect(resumed.some((line) => line.startsWith(`- [${CRITERION}] timed out after `))).toBe(true);

      // 6. The environment quiets down; the SAME attempt re-runs the gate and passes.
      rmSync(join(projectRoot, SLOW_FLAG));
      const green = await submitSuccess(second, runId, 1);
      expect(green).toContain("Gate verdict for slow-gate/implement (attempt 1): PASS");
      const closed = await callText(second, "workflow_step", { run_id: runId, harvest_artifacts: [] });
      expect(closed).toContain("the phase is closed");
      expect(closed).toContain("RUN COMPLETE");
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "after two inconclusive runs the third timeout of the attempt is counted as a failure",
    async () => {
      const projectRoot = await buildBusyProject();
      const corpusHome = mkdtempSync(join(tmpdir(), "mneme-gate-e2e-home-"));
      const session = await openSession(projectRoot, corpusHome, 1);
      const runId = await startRun(session, await migratedPhaseText(session));
      await callText(session, "workflow_step", {});

      expect(await submitSuccess(session, runId, 1)).toContain(
        "Gate verdict for slow-gate/implement (attempt 1): INCONCLUSIVE",
      );
      expect(await submitSuccess(session, runId, 1)).toContain(
        "Gate verdict for slow-gate/implement (attempt 1): INCONCLUSIVE",
      );
      const counted = await submitSuccess(session, runId, 1);

      expect(counted).toContain("Gate verdict for slow-gate/implement (attempt 1): FAIL");
      expect(counted).toContain(
        "Timeout counted as a failure: 2 environment re-runs already spent on attempt 1.",
      );
      expect(counted).toContain("attempt: 2");
      expect(counted.join("\n")).not.toContain(INCONCLUSIVE_DIRECTIVE_HEADER);
    },
    E2E_TIMEOUT_MS,
  );
});
