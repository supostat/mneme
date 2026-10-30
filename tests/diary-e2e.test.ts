import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compileServer } from "../scripts/build-plugin";
import { resolveCorpus } from "../src/corpus";
import { DIARY_TAG, runTag } from "../src/diary/diary-entries";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter, readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { appendSessionStart, buildServer, createSessionEndHandler } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The wire test of the diary, end to end on the real modules and the real binary entry. The MCP
// path: a run driven through the workflow tools of a real server — one red gate attempt, a retry, a
// harvest of two kinds — then diary_facts for that run, a human accept through staging_resolve and a
// diary entry through remember, with the corpus byte-identical around every diary_facts call. The
// hook path: a session opened the way main() opens it, a manual recall that finds nothing, and the
// engine SPAWNED as `bun run src/mcp-server.ts diary --brief` — and once as the compiled artefact the
// hook actually runs — against the corpus under a redirected HOME. The proof is DISCRIMINATING: the
// same spawn WITHOUT argv is the MCP server, which logs its session and changes the snapshot.

const REPO_ROOT = join(import.meta.dir, "..");
const SERVER_ENTRY = join(REPO_ROOT, "src", "mcp-server.ts");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-10-30T10:00:00.000Z");
const E2E_TIMEOUT_MS = 60_000;
const COMPILE_TIMEOUT_MS = 60_000;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;
const MARKER_FILE = "gate.marker";
const GAP_QUERY = "quantum chromodynamics lattice";
const TWO_ATTEMPTS = [{ id: "implement", max_attempts: 2, on_fail: { action: "escalate" } }];

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
  corpusHome: string;
}

// One server session over the project's corpus: its client, and the EventWriter main() would hand
// to appendSessionStart, so the test opens and closes the session exactly as the binary does.
interface Session {
  client: Client;
  eventWriter: EventWriter;
}

interface SpawnOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function buildProject(): Promise<Project> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-diary-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const tempHome = mkdtempSync(join(tmpdir(), "mneme-diary-e2e-home-"));
  return { projectRoot, tempHome, corpusHome: join(tempHome, ".mneme") };
}

// Several sessions over one corpus share ONE idFactory: the server draws its session id from the
// first call, so a fresh factory per session would mint the same id twice.
async function openSession(project: Project, idFactory: () => string): Promise<Session> {
  const options: CreateServerOptions = { projectRoot: project.projectRoot, corpusHome: project.corpusHome, embeddings: bagClient(), idFactory, clock: fixedClock };
  const { server, context } = buildServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, eventWriter: (await context()).eventWriter };
}

async function corpusDirOf(project: Project): Promise<string> {
  return (await resolveCorpus(project.projectRoot, { corpusHome: project.corpusHome })).corpusDir;
}

async function callText(session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await session.client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

function phaseText(command: string): string {
  return serializePhaseDocument({
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "Wire the ledger reconciliation",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "the marker exists", command, timeoutSeconds: null }],
    knowledge: [],
  });
}

async function startRun(session: Session, command: string): Promise<string> {
  const text = await callText(session, "workflow_start", { phases: [phaseText(command)], steps: TWO_ATTEMPTS, max_iterations: 10 });
  const match = text.match(/Started workflow run (\S+) on branch/);
  if (match === null) throw new Error(`workflow_start did not report a run id:\n${text}`);
  return match[1]!;
}

async function submitStep(session: Session, runId: string, attempt: number): Promise<string> {
  return callText(session, "workflow_step", {
    run_id: runId,
    step_result: { phase_id: "phase-one", step_id: "implement", attempt, outcome: "success" },
  });
}

// A run that goes red once (the marker is missing), passes on the retry, and stages two kinds.
async function runWithOneRedAttempt(session: Session, project: Project): Promise<string> {
  const runId = await startRun(session, `test -f ${MARKER_FILE}`);
  await callText(session, "workflow_step", {});
  expect(await submitStep(session, runId, 1)).toContain("FAIL");
  writeFileSync(join(project.projectRoot, MARKER_FILE), "");
  expect(await submitStep(session, runId, 2)).toContain("PASS");
  await callText(session, "workflow_step", {
    run_id: runId,
    harvest_artifacts: [
      { kind: "decision", decision: "reconcile the ledger nightly", rationale: "the bank feed lands at midnight", anchors: ["src/a.ts"] },
      { kind: "fixed_test", test: "ledger totals match", failure: "rounding drift", fix: "integer cents", anchors: ["src/a.ts"] },
    ],
    used_notes: [],
  });
  return runId;
}

// A run that passes at once and stages nothing: the branch's last finished run, without an entry.
async function cleanRun(session: Session): Promise<string> {
  const runId = await startRun(session, "true");
  await callText(session, "workflow_step", {});
  expect(await submitStep(session, runId, 1)).toContain("PASS");
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

function diaryBriefViaBun(project: Project): Promise<SpawnOutcome> {
  return spawnEngine(["bun", "run", SERVER_ENTRY, "diary", "--brief"], project);
}

// Every regular file under the corpus, keyed by its relative path, with the sha256 of its bytes —
// the corpus's own .git included, so a diary call that committed anything would show up.
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

// diary_facts through the client, with the corpus proven byte-identical around the call.
async function diaryFactsUntouched(session: Session, corpusDir: string, args: Record<string, unknown>): Promise<string> {
  const before = snapshotTree(corpusDir);
  const text = await callText(session, "diary_facts", args);
  expectIdenticalSnapshots(before, snapshotTree(corpusDir));
  return text;
}

function eventsOfType(events: StoredEvent[], type: string): StoredEvent[] {
  return events.filter((event) => event.type === type);
}

function expectBriefLine(outcome: SpawnOutcome, line: string): void {
  expect(outcome.timedOut).toBe(false);
  expect(outcome.stdout).toBe(`${line}\n`);
  expect(outcome.stderr).toBe("");
  expect(outcome.exitCode).toBe(0);
}

describe("the diary over MCP: a run's facts, the curation of its notes and its entry", () => {
  test(
    "diary_facts reads the run the workflow tools drove, follows the human's accept, sees the entry, and writes nothing",
    async () => {
      const project = await buildProject();
      const session = await openSession(project, sequentialIds());
      const corpusDir = await corpusDirOf(project);
      const runId = await runWithOneRedAttempt(session, project);

      const fresh = await diaryFactsUntouched(session, corpusDir, { run_id: runId });

      expect(fresh.split("\n")).toEqual([
        `Diary facts for run ${runId} on branch "main". Nothing was written: no event, no file, no stale mark.`,
        "status complete · started 2026-10-30T10:00:00.000Z · ended 2026-10-30T10:00:00.000Z · iterations 2/10",
        "diary entry: none",
        "curation: staged 2 · accepted 0 · rejected 0 · superseded 0",
        "phase phase-one: attempts 2 · bundle gap yes · harvest bugfix 1, decision 1 · used notes 0",
        "  gate fail · attempt 1 · executable · the marker exists · exit-nonzero",
      ]);

      const bugfix = eventsOfType(readEvents(join(corpusDir, "events")), "remember").find((event) => event.note_type === "bugfix")!;
      await callText(session, "staging_resolve", { id: bugfix.note_id, decision: "accept" });
      const curated = await diaryFactsUntouched(session, corpusDir, { run_id: runId });

      expect(curated).toContain("curation: staged 1 · accepted 1 · rejected 0 · superseded 0");
      expect(curated).toContain("diary entry: none");

      await callText(session, "remember", {
        type: "decision",
        body: "Retro: the gate went red once because the marker was missing; the retry passed.",
        anchors: [],
        tags: [DIARY_TAG, runTag(runId)],
      });
      const withEntry = await diaryFactsUntouched(session, corpusDir, { run_id: runId });

      expect(withEntry).toContain("diary entry: present");
      expect(await diaryFactsUntouched(session, corpusDir, {})).toContain(
        `last terminal run on branch "main": ${runId} [complete] has a diary entry`,
      );
    },
    E2E_TIMEOUT_MS,
  );
});

describe("the diary line spawned as a process for the hook", () => {
  test(
    "one live session with an open gap: stdout is the tool's brief line; a second live session degrades it; a note closes the gap",
    async () => {
      const project = await buildProject();
      const ids = sequentialIds();
      const first = await openSession(project, ids);
      const corpusDir = await corpusDirOf(project);
      const runId = await cleanRun(first);
      appendSessionStart(first.eventWriter);
      await callText(first, "recall", { query: GAP_QUERY });
      const toolBrief = await callText(first, "diary_facts", { brief: true });
      const runSegment = `diary: run ${runId} complete without a diary entry`;
      const before = snapshotTree(corpusDir);

      const alone = await diaryBriefViaBun(project);

      expectBriefLine(alone, toolBrief);
      expect(toolBrief).toBe(`${runSegment} · memory gaps since the last note: "${GAP_QUERY}"`);
      expectIdenticalSnapshots(before, snapshotTree(corpusDir));

      const second = await openSession(project, ids);
      appendSessionStart(second.eventWriter);

      expectBriefLine(await diaryBriefViaBun(project), `${runSegment} · memory gaps: n/a — 2 live sessions share this corpus`);

      createSessionEndHandler(second.eventWriter)();

      expectBriefLine(await diaryBriefViaBun(project), toolBrief);

      await callText(first, "remember", { type: "decision", body: "Lattice QCD is out of scope here.", anchors: ["src/a.ts"] });

      expectBriefLine(await diaryBriefViaBun(project), runSegment);

      createSessionEndHandler(first.eventWriter)();

      expectBriefLine(await diaryBriefViaBun(project), runSegment);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "control: the same spawn WITHOUT argv is the MCP server — it logs a session_start with its pid, a session_end, and changes the corpus",
    async () => {
      const project = await buildProject();
      await openSession(project, sequentialIds());
      const corpusDir = await corpusDirOf(project);
      const before = snapshotTree(corpusDir);
      expect(eventsOfType(readEvents(join(corpusDir, "events")), "session_start")).toEqual([]);

      const outcome = await spawnEngine(["bun", "run", SERVER_ENTRY], project);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.exitCode).toBe(0);
      const events = readEvents(join(corpusDir, "events"));
      const [started] = eventsOfType(events, "session_start");
      expect(Number.isInteger(started!.pid)).toBe(true);
      expect(started!.pid as number).toBeGreaterThan(0);
      expect(eventsOfType(events, "session_end")).toHaveLength(1);
      expect(snapshotsDiffer(before, snapshotTree(corpusDir))).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );
});

// The hook runs the COMPILED artefact, and the one assumption only a compile can check is the argv
// layout: process.argv.slice(2) must name the subcommand there exactly as under `bun run`.
describe("diary --brief on the compiled binary", () => {
  let binDir: string;
  let compiledBinary: string;

  beforeAll(async () => {
    binDir = mkdtempSync(join(tmpdir(), "mneme-diary-e2e-bin-"));
    compiledBinary = join(binDir, "mneme");
    await compileServer(binDir, compiledBinary);
  }, COMPILE_TIMEOUT_MS);

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test(
    "the compiled binary answers the same brief line, exits 0 and leaves the corpus byte-identical",
    async () => {
      const project = await buildProject();
      const session = await openSession(project, sequentialIds());
      const corpusDir = await corpusDirOf(project);
      await cleanRun(session);
      appendSessionStart(session.eventWriter);
      await callText(session, "recall", { query: GAP_QUERY });
      const toolBrief = await callText(session, "diary_facts", { brief: true });
      const before = snapshotTree(corpusDir);

      const outcome = await spawnEngine([compiledBinary, "diary", "--brief"], project);

      expectBriefLine(outcome, toolBrief);
      expect(toolBrief).toContain(`memory gaps since the last note: "${GAP_QUERY}"`);
      expectIdenticalSnapshots(before, snapshotTree(corpusDir));
    },
    E2E_TIMEOUT_MS,
  );
});
