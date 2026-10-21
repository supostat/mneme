import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compileServer } from "../scripts/build-plugin";
import { CONFIG_FILE_NAME } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The wire test of the survey CLI, end to end on the REAL binary entry: the engine is SPAWNED as a
// process — `bun run src/mcp-server.ts survey --brief`, and once as the compiled artefact the hook
// actually runs — against a corpus a real in-process MCP server provisioned under a redirected HOME.
// "Writes nothing" is proven the only way it can be: a byte-for-byte snapshot of the whole corpus
// tree before and after the spawn must be identical, and a corpus that does not exist must still not
// exist afterwards. The proof is DISCRIMINATING: the same spawn WITHOUT argv is the MCP server, which
// provisions, logs session_start and changes the snapshot — so an identical snapshot after the CLI is
// a fact about the CLI's dispatch, not about the scenario.

const REPO_ROOT = join(import.meta.dir, "..");
const SERVER_ENTRY = join(REPO_ROOT, "src", "mcp-server.ts");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-10-06T10:00:00.000Z");
const E2E_TIMEOUT_MS = 60_000;
const COMPILE_TIMEOUT_MS = 60_000;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;
const SINGLE_STEP = [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }];

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
  return { model: EMBEDDING_MODEL, embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

interface Project {
  projectRoot: string;
  tempHome: string;
}

interface Session extends Project {
  client: Client;
  corpusDir: string;
}

interface SpawnOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function buildProject(): Promise<Project> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-survey-cli-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return { projectRoot, tempHome: mkdtempSync(join(tmpdir(), "mneme-survey-cli-home-")) };
}

// The corpus lives where the spawned engine will look for it: HOME/.mneme, with HOME redirected to
// the project's temporary home. The in-process server provisions it; the spawned CLI only locates it.
async function openSession(): Promise<Session> {
  const project = await buildProject();
  const corpusHome = join(project.tempHome, ".mneme");
  const client = await connect({
    projectRoot: project.projectRoot,
    corpusHome,
    embeddings: bagClient(),
    idFactory: sequentialIds(),
    clock: fixedClock,
  });
  const corpus = await resolveCorpus(project.projectRoot, { corpusHome });
  return { ...project, client, corpusDir: corpus.corpusDir };
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
    doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
    knowledge: [],
  });
}

async function startRun(session: Session, phases: string[]): Promise<string> {
  const text = await callText(session, "workflow_start", { phases, steps: SINGLE_STEP, max_iterations: 10 });
  const match = text.match(/Started workflow run (\S+) on branch/);
  if (match === null) throw new Error(`workflow_start did not report a run id:\n${text}`);
  return match[1]!;
}

// A two-phase run whose first phase is closed: the run sits on a phase boundary with the next
// phase's recall pending — the most common state a session-start hook finds.
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

// The engine as the hook runs it: a child process in the PROJECT directory with HOME redirected, no
// stdin. PATH survives through ...process.env so git resolves. The timer proves NATURAL exit.
async function spawnEngine(cmd: string[], project: Project): Promise<SpawnOutcome> {
  const child = Bun.spawn({
    cmd,
    cwd: project.projectRoot,
    env: { ...process.env, HOME: project.tempHome },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PROCESS_EXIT_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

function surveyBriefViaBun(project: Project): Promise<SpawnOutcome> {
  return spawnEngine(["bun", "run", SERVER_ENTRY, "survey", "--brief"], project);
}

// Every regular file under the corpus, keyed by its relative path, with the sha256 of its bytes —
// the corpus's own .git included, so a survey that committed anything would show up.
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

function snapshotsDiffer(before: Map<string, string>, after: Map<string, string>): boolean {
  return after.size !== before.size || [...after.entries()].some(([path, hash]) => before.get(path) !== hash);
}

function eventsOfType(events: StoredEvent[], type: string): StoredEvent[] {
  return events.filter((event) => event.type === type);
}

function expectQuietExit(outcome: SpawnOutcome): void {
  expect(outcome.timedOut).toBe(false);
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toBe("");
  expect(outcome.exitCode).toBe(0);
}

describe("survey --brief spawned as a process writes nothing", () => {
  test(
    "(a) an active run with one closed phase: stdout is the tool's brief line plus a newline, and the corpus is byte-identical",
    async () => {
      const session = await openSession();
      await runWithOneClosedPhase(session);
      const brief = await callText(session, "workflow_survey", { brief: true });
      const before = snapshotTree(session.corpusDir);

      const outcome = await surveyBriefViaBun(session);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toBe(`${brief}\n`);
      expect(outcome.stderr).toBe("");
      expect(outcome.exitCode).toBe(0);
      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(b) a corpus with no run: silence, and the corpus is byte-identical",
    async () => {
      const session = await openSession();
      const before = snapshotTree(session.corpusDir);

      const outcome = await surveyBriefViaBun(session);

      expectQuietExit(outcome);
      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(c) a detached HEAD over an active run: silence, and the corpus is byte-identical",
    async () => {
      const session = await openSession();
      await runWithOneClosedPhase(session);
      await runGit(session.projectRoot, ["checkout", "-q", "--detach"]);
      const before = snapshotTree(session.corpusDir);

      const outcome = await surveyBriefViaBun(session);

      expectQuietExit(outcome);
      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(d) no corpus at all: silence, and HOME/.mneme still does not exist afterwards",
    async () => {
      const project = await buildProject();

      const outcome = await surveyBriefViaBun(project);

      expectQuietExit(outcome);
      expect(existsSync(join(project.tempHome, ".mneme"))).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "(e) a broken .mneme.json over an active run: silence, and the corpus is byte-identical",
    async () => {
      const session = await openSession();
      await runWithOneClosedPhase(session);
      writeFileSync(join(session.projectRoot, CONFIG_FILE_NAME), "{ not json");
      const before = snapshotTree(session.corpusDir);

      const outcome = await surveyBriefViaBun(session);

      expectQuietExit(outcome);
      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "control: the same spawn WITHOUT argv is still the MCP server — it logs session_start and session_end and changes the corpus",
    async () => {
      const session = await openSession();
      const before = snapshotTree(session.corpusDir);
      expect(eventsOfType(readEvents(join(session.corpusDir, "events")), "session_start")).toEqual([]);

      const outcome = await spawnEngine(["bun", "run", SERVER_ENTRY], session);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.exitCode).toBe(0);
      const events = readEvents(join(session.corpusDir, "events"));
      expect(eventsOfType(events, "session_start")).toHaveLength(1);
      expect(eventsOfType(events, "session_end")).toHaveLength(1);
      expect(snapshotsDiffer(before, snapshotTree(session.corpusDir))).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );
});

// The hook runs the COMPILED artefact, and the one assumption only a compile can check is the argv
// layout: process.argv.slice(2) must name the subcommand there exactly as under `bun run`.
describe("survey --brief on the compiled binary", () => {
  let binDir: string;
  let compiledBinary: string;

  beforeAll(async () => {
    binDir = mkdtempSync(join(tmpdir(), "mneme-survey-cli-bin-"));
    compiledBinary = join(binDir, "mneme");
    await compileServer(binDir, compiledBinary);
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test(
    "the compiled binary answers the same brief line, exits 0 and leaves the corpus byte-identical",
    async () => {
      const session = await openSession();
      await runWithOneClosedPhase(session);
      const brief = await callText(session, "workflow_survey", { brief: true });
      const before = snapshotTree(session.corpusDir);

      const outcome = await spawnEngine([compiledBinary, "survey", "--brief"], session);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toBe(`${brief}\n`);
      expect(outcome.stderr).toBe("");
      expect(outcome.exitCode).toBe(0);
      expectIdenticalSnapshots(before, snapshotTree(session.corpusDir));
    },
    E2E_TIMEOUT_MS,
  );
});
