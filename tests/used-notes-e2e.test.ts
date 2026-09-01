import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_DIMENSION } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The wire test of the usefulness loop, end to end on REAL modules: a note crosses the human gate,
// the engine compiles a bundle that carries it, the harvest declares it used, a second SESSION
// (a fresh server over the same corpus, restoring the run from the log alone) still enforces the
// same membership rule, and stats reads the numbers back out of the log. The only stand-in is the
// embedder, and it is deterministic so the bundle's contents are a fact of the test, not a hope.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NOW = new Date("2026-09-01T10:00:00.000Z");
const fixedClock = () => NOW;
const E2E_TIMEOUT_MS = 60000;

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
  return { embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
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

async function openSession(
  projectRoot: string,
  corpusHome: string,
  idStart: number,
): Promise<Session> {
  const client = await connect({
    projectRoot,
    corpusHome,
    embeddings: bagClient(),
    idFactory: sequentialIds(idStart),
    clock: fixedClock,
  });
  return { client, projectRoot, corpusHome };
}

async function buildProject(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-loop-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
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

async function callResult(session: Session, name: string, args: Record<string, unknown>) {
  return session.client.callTool({ name, arguments: args });
}

async function loggedEvents(session: Session): Promise<StoredEvent[]> {
  const corpus = await resolveCorpus(session.projectRoot, { corpusHome: session.corpusHome });
  return readEvents(corpus.eventsDir);
}

function harvestEvents(events: StoredEvent[]): StoredEvent[] {
  return events.filter(
    (event) => event.type === "workflow_step_applied" && event.result_kind === "harvest",
  );
}

const PHASE_DESCRIPTION = "ranking probe module evidence window closure";

function probePhase(id: string, deps: string[] = []): string {
  return serializePhaseDocument({
    id,
    deps,
    agentRole: "coder",
    description: PHASE_DESCRIPTION,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "green", command: "true" }],
    knowledge: [],
  });
}

async function acceptNote(session: Session, body: string): Promise<string> {
  const staged = await callText(session, "remember", { type: "decision", body, anchors: ["src/a.ts"] });
  const noteId = /Staged note ([0-9a-fA-F-]{36}|[0-9A-Z]{26})/.exec(staged)?.[1];
  if (noteId === undefined) throw new Error(`could not read the staged note id from: ${staged}`);
  await callText(session, "staging_resolve", { id: noteId, decision: "accept" });
  return noteId;
}

async function startRun(session: Session, phases: string[]): Promise<string> {
  const started = await callText(session, "workflow_start", {
    phases,
    steps: [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }],
    max_iterations: 10,
  });
  const runId = /Started workflow run ([0-9a-fA-F-]{36}|[0-9A-Z]{26})/.exec(started)?.[1];
  if (runId === undefined) throw new Error(`could not read the run id from: ${started}`);
  return runId;
}

describe("the usefulness loop, end to end", () => {
  test(
    "a note crosses the gate, reaches a bundle, is declared used, and shows up in stats",
    async () => {
      const projectRoot = await buildProject();
      const corpusHome = mkdtempSync(join(tmpdir(), "mneme-loop-home-"));
      const first = await openSession(projectRoot, corpusHome, 1);
      const noteId = await acceptNote(first, "Decision: the ranking probe module closes its evidence window");

      const runId = await startRun(first, [probePhase("phase-one"), probePhase("phase-two", ["phase-one"])]);

      // 1. The bundle the engine compiled really carries the accepted note.
      const opened = await callText(first, "workflow_step", {});
      expect(opened).toContain('Recall bundle for phase "phase-one"');
      expect(opened).toContain(noteId);

      await callText(first, "workflow_step", {
        run_id: runId,
        step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" },
      });

      // 2. A declaration naming a note the phase never surfaced refuses the WHOLE call.
      const refused = await callResult(first, "workflow_step", {
        run_id: runId,
        harvest_artifacts: [],
        used_notes: [{ id: ulid(90), evidence: "claimed, but never surfaced" }],
      });
      expect(refused.isError).toBe(true);
      expect(harvestEvents(await loggedEvents(first)).length).toBe(0);

      // 3. The honest declaration closes the phase and lands in the log.
      const closed = await callText(first, "workflow_step", {
        run_id: runId,
        harvest_artifacts: [],
        used_notes: [{ id: noteId, evidence: "its window rule shaped the closure check" }],
      });
      expect(closed).toContain("the phase is closed");
      const afterFirstPhase = harvestEvents(await loggedEvents(first));
      expect(afterFirstPhase.length).toBe(1);
      expect(afterFirstPhase[0]!.used_notes).toEqual([
        { id: noteId, evidence: "its window rule shaped the closure check" },
      ]);

      // 4. A SECOND SESSION restores the run from the log alone — and still enforces membership
      // against phase two's own bundle, which only the fold can tell it about.
      const second = await openSession(projectRoot, corpusHome, 500);
      const resumed = await callText(second, "workflow_step", {});
      expect(resumed).toContain('Recall bundle for phase "phase-two"');
      await callText(second, "workflow_step", {
        run_id: runId,
        step_result: { phase_id: "phase-two", step_id: "implement", attempt: 1, outcome: "success" },
      });
      const refusedAfterRestore = await callResult(second, "workflow_step", {
        run_id: runId,
        harvest_artifacts: [],
        used_notes: [{ id: ulid(91), evidence: "still never surfaced" }],
      });
      expect(refusedAfterRestore.isError).toBe(true);
      expect((refusedAfterRestore.content as Array<{ text: string }>)[0]!.text).toContain(
        "was not in this phase's recall bundle",
      );
      await callText(second, "workflow_step", {
        run_id: runId,
        harvest_artifacts: [],
        used_notes: [{ id: noteId, evidence: "the same rule closed phase two's window too" }],
      });

      // 5. stats reads both numbers back out of the log the run itself wrote.
      const stats = await callText(second, "stats", {});
      expect(stats).toContain("Note usefulness (from the event log; self-declared, read as an upper bound)");
      expect(stats).toContain("(l) Precision-of-use, all time: 2/2 (100%) [decision 2/2 (100%)]");
      expect(stats).toContain("(m) Declaration coverage: 2/2 harvests declared usage (100%)");
      // Neutrality holds at the surface the agent actually reads.
      expect(closed.toLowerCase()).not.toContain("precision");
      expect(resumed.toLowerCase()).not.toContain("precision");
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "an uninstrumented run leaves precision without data while coverage reports the gap",
    async () => {
      const projectRoot = await buildProject();
      const corpusHome = mkdtempSync(join(tmpdir(), "mneme-loop-home-"));
      const session = await openSession(projectRoot, corpusHome, 1);
      await acceptNote(session, "Decision: the ranking probe module closes its evidence window");
      const runId = await startRun(session, [probePhase("phase-one")]);
      await callText(session, "workflow_step", {});
      await callText(session, "workflow_step", {
        run_id: runId,
        step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" },
      });
      await callText(session, "workflow_step", { run_id: runId, harvest_artifacts: [] });

      const stats = await callText(session, "stats", {});

      expect(stats).toContain("(l) Precision-of-use, all time: no data");
      expect(stats).toContain("(m) Declaration coverage: 0/1 harvests declared usage (0%)");
    },
    E2E_TIMEOUT_MS,
  );
});
