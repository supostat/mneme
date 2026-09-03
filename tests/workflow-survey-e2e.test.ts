import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

// The wire test of the read-only survey, end to end on REAL modules: a real MCP client over a real
// server, a real git repository, a real corpus on disk. "Writes nothing" is proven the only way it
// can be — a byte-for-byte snapshot of the whole corpus tree (events, staging, index, the corpus's
// own git) taken before and after the call must be identical — and the proof is DISCRIMINATING:
// the same scenario driven through workflow_step DOES change the snapshot, so an identical
// snapshot after survey is a fact about survey, not about the scenario. The only stand-in is the
// embedder, and it is deterministic.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-09-03T10:00:00.000Z");
const E2E_TIMEOUT_MS = 60000;

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(): () => string {
  let counter = 0;
  return () => ulid(counter++);
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
  corpusDir: string;
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function buildProject(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-survey-proj-"));
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

async function openSession(): Promise<Session> {
  const projectRoot = await buildProject();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-survey-home-"));
  const client = await connect({ projectRoot, corpusHome, embeddings: bagClient(), idFactory: sequentialIds(), clock: fixedClock });
  const corpus = await resolveCorpus(projectRoot, { corpusHome });
  return { client, projectRoot, corpusHome, corpusDir: corpus.corpusDir };
}

async function callText(session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await session.client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

function phaseText(id: string, deps: string[] = []): string {
  return serializePhaseDocument({
    id,
    deps,
    agentRole: "coder",
    description: `Work on ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "always green", command: "true" }],
    knowledge: [],
  });
}

const SINGLE_STEP = [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }];

async function startRun(session: Session, phases: string[]): Promise<string> {
  const text = await callText(session, "workflow_start", { phases, steps: SINGLE_STEP, max_iterations: 10 });
  const match = text.match(/Started workflow run (\S+) on branch/);
  if (match === null) throw new Error(`workflow_start did not report a run id:\n${text}`);
  return match[1]!;
}

// Every regular file under the corpus, keyed by its relative path, with the sha256 of its bytes.
// Directories are implied by their files; the corpus's own .git is included on purpose — a survey
// that committed anything would show up there.
function snapshotTree(rootDir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        snapshot.set(relative(rootDir, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  walk(rootDir);
  return snapshot;
}

function expectIdenticalSnapshots(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [path, hash] of before) {
    expect(after.get(path)).toBe(hash);
  }
}

function staleMarks(events: StoredEvent[]): StoredEvent[] {
  return events.filter((event) => event.type === "workflow_run_marked_stale");
}

// Scenario (a): a two-phase run on main whose first phase is already closed, so the run sits on a
// phase boundary with the next phase's recall pending — the most common state a resume finds.
async function runWithOneClosedPhase(session: Session): Promise<string> {
  const runId = await startRun(session, [phaseText("phase-one"), phaseText("phase-two", ["phase-one"])]);
  await callText(session, "workflow_step", {});
  await callText(session, "workflow_step", {
    run_id: runId,
    step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" },
  });
  await callText(session, "workflow_step", { run_id: runId, harvest_artifacts: [] });
  return runId;
}

describe("workflow_survey is read-only by construction", () => {
  test(
    "(a) an active run with one closed phase: the corpus is byte-identical after the map, and the map names the state the next step confirms",
    async () => {
      const session = await openSession();
      const runId = await runWithOneClosedPhase(session);
      const before = snapshotTree(session.corpusDir);

      const map = await callText(session, "workflow_survey", {});

      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
      expect(map).toContain(`Active run ${runId} status=running`);
      expect(map).toContain("phase phase-two · pending: recall for phase phase-two");
      expect(map).toContain("Staged notes awaiting review: 0");

      // The survey named phase-two; the next step must open exactly that phase, and once it has,
      // a fresh survey must describe the directive the step just issued, token for token.
      const directive = await callText(session, "workflow_step", {});
      expect(directive).toContain("DIRECTIVE: execute_step\nphase: phase-two\nstep: implement\nattempt: 1");
      const afterStep = await callText(session, "workflow_survey", {});
      expect(afterStep).toContain("phase phase-two · pending: execute_step phase-two/implement attempt 1");
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(b) a run whose branch was deleted: survey leaves the corpus untouched, while the same scenario through workflow_step writes the stale mark",
    async () => {
      const session = await openSession();
      await runGit(session.projectRoot, ["checkout", "-q", "-b", "feature"]);
      const featureRunId = await startRun(session, [phaseText("phase-one")]);
      await runGit(session.projectRoot, ["checkout", "-q", "main"]);
      await runGit(session.projectRoot, ["branch", "-q", "-D", "feature"]);
      const before = snapshotTree(session.corpusDir);

      const map = await callText(session, "workflow_survey", {});
      const line = await callText(session, "workflow_survey", { brief: true });

      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
      expect(map).toContain(`- run ${featureRunId} on branch "feature": branch not found`);
      expect(line).toBe("main · no unfinished run · staged 0");
      expect(staleMarks(readEvents(join(session.corpusDir, "events")))).toEqual([]);

      // Discrimination control: the writing survey behind workflow_step marks the orphan, so the
      // snapshot changes — an identical snapshot above was survey's doing, not the scenario's.
      const stepped = await callText(session, "workflow_step", {});
      const afterStep = snapshotTree(session.corpusDir);

      expect(stepped).toContain("STALE RUNS (branch not found):");
      expect(staleMarks(readEvents(join(session.corpusDir, "events"))).length).toBe(1);
      expect([...afterStep.entries()].some(([path, hash]) => before.get(path) !== hash)).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(c) a detached HEAD: both shapes answer informationally and the corpus is byte-identical",
    async () => {
      const session = await openSession();
      await runWithOneClosedPhase(session);
      await runGit(session.projectRoot, ["checkout", "-q", "--detach"]);
      const before = snapshotTree(session.corpusDir);

      for (const args of [{}, { brief: true }]) {
        const result = await session.client.callTool({ name: "workflow_survey", arguments: args });
        expect(result.isError).toBeUndefined();
        const text = (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
        expect(text).toContain("HEAD is detached");
        expect(text).toContain("No run state was read or changed.");
      }

      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(d) brief: true on the active run: one line, and the corpus is byte-identical",
    async () => {
      const session = await openSession();
      const runId = await runWithOneClosedPhase(session);
      const before = snapshotTree(session.corpusDir);

      const line = await callText(session, "workflow_survey", { brief: true });

      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
      expect(line).not.toContain("\n");
      expect(line).toBe(
        `main · run ${runId} [running] · phase phase-two [pending: recall for phase phase-two] · staged 0 · last 2026-09-03T10:00:00.000Z`,
      );
    },
    E2E_TIMEOUT_MS,
  );
});
