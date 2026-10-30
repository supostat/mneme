import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../embeddings";
import type { EmbeddingsClient } from "../embeddings";
import { EventWriter } from "../events";
import { initRepo, runGit } from "../git";
import { createServer } from "../mcp-server";
import { serializePhaseDocument } from "../workflow/phase-document";
import { DIARY_TAG, runTag } from "./diary-entries";
import { BRIEF_WITH_RUN_ID_TEXT, DIARY_BRIEF_NOTHING, RUN_ID_INVALID_TEXT } from "./diary-rendering";

// diary_facts through a real MCP server: a run driven to completion with the workflow tools, a
// manual recall that finds nothing, then every form of the tool. The tool must answer each
// non-answer as plain text (a throw would make the server's dispatch log a tool_error) and must
// leave the event log byte for byte as it found it.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fixedClock = () => new Date("2026-10-30T10:00:00.000Z");
const GHOST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FX0";
const UNKNOWN_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FX1";
const GAP_QUERY = "quantum chromodynamics lattice";
const SINGLE_STEP = [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }];

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
  return { model: EMBEDDING_MODEL, embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

interface Bench {
  client: Client;
  projectRoot: string;
  eventsDir: string;
}

async function makeBench(): Promise<Bench> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-diary-tool-proj-"));
  await initRepo(projectRoot);
  writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-diary-tool-home-"));
  let counter = 0;
  const server = createServer({ projectRoot, corpusHome, embeddings: bagClient(), idFactory: () => ulid(counter++), clock: fixedClock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const corpus = await resolveCorpus(projectRoot, { corpusHome });
  return { client, projectRoot, eventsDir: corpus.eventsDir };
}

interface ToolAnswer {
  text: string;
  isError: boolean;
}

async function call(bench: Bench, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await bench.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
  return { text, isError: result.isError === true };
}

function phaseText(id: string): string {
  return serializePhaseDocument({
    id,
    deps: [],
    agentRole: "coder",
    description: `Wire the ledger ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
    knowledge: [],
  });
}

async function startRun(bench: Bench, phaseId: string): Promise<string> {
  const started = await call(bench, "workflow_start", { phases: [phaseText(phaseId)], steps: SINGLE_STEP, max_iterations: 10 });
  return started.text.match(/Started workflow run (\S+) on branch/)![1]!;
}

async function completeRun(bench: Bench): Promise<string> {
  const runId = await startRun(bench, "phase-one");
  await call(bench, "workflow_step", {});
  await call(bench, "workflow_step", {
    run_id: runId,
    step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" },
  });
  await call(bench, "workflow_step", {
    run_id: runId,
    harvest_artifacts: [{ kind: "decision", decision: "reconcile nightly", rationale: "the feed lands at midnight", anchors: ["a.ts"] }],
  });
  return runId;
}

function snapshotEvents(eventsDir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(eventsDir).sort().map((name) => [name, readFileSync(join(eventsDir, name), "utf8")]));
}

describe("diary_facts over MCP", () => {
  test("answers both forms and the brief line from a real run and a real gap, writing nothing", async () => {
    const bench = await makeBench();
    const runId = await completeRun(bench);
    await call(bench, "recall", { query: GAP_QUERY });
    const before = snapshotEvents(bench.eventsDir);

    const runForm = await call(bench, "diary_facts", { run_id: runId });
    const sessionForm = await call(bench, "diary_facts", {});
    const brief = await call(bench, "diary_facts", { brief: true });

    expect(runForm.isError).toBe(false);
    expect(runForm.text.split("\n")).toEqual([
      `Diary facts for run ${runId} on branch "main". Nothing was written: no event, no file, no stale mark.`,
      "status complete · started 2026-10-30T10:00:00.000Z · ended 2026-10-30T10:00:00.000Z · iterations 1/10",
      "diary entry: none",
      "curation: staged 1 · accepted 0 · rejected 0 · superseded 0",
      "phase phase-one: attempts 1 · bundle gap yes · harvest decision 1 · used notes not instrumented",
    ]);
    expect(sessionForm.text.split("\n")).toEqual([
      `Diary facts for session ${ulid(0)}. Nothing was written: no event, no file, no stale mark.`,
      "recalls 1 · memory gaps 1 · notes 0",
      "memory gaps, oldest first:",
      `- 2026-10-30T10:00:00.000Z "${GAP_QUERY}" (open)`,
      `last terminal run on branch "main": ${runId} [complete] without a diary entry`,
    ]);
    expect(brief.text).toBe(`diary: run ${runId} complete without a diary entry · memory gaps since the last note: "${GAP_QUERY}"`);
    expect(snapshotEvents(bench.eventsDir)).toEqual(before);
  });

  test("a diary entry for the run and a note after the gap leave the brief nothing to note", async () => {
    const bench = await makeBench();
    const runId = await completeRun(bench);
    await call(bench, "recall", { query: GAP_QUERY });
    await call(bench, "remember", {
      type: "decision",
      body: "Retro: the ledger phase ran clean on the first attempt.",
      anchors: [],
      tags: [DIARY_TAG, runTag(runId)],
    });

    const brief = await call(bench, "diary_facts", { brief: true });

    expect(brief).toEqual({ text: DIARY_BRIEF_NOTHING, isError: false });
  });

  test("every non-answer is plain text, never an error, and the log is untouched", async () => {
    const bench = await makeBench();
    const runId = await completeRun(bench);
    const runningId = await startRun(bench, "phase-two");
    const corpusWriter = new EventWriter(bench.eventsDir, { sessionId: "s-seed", clock: fixedClock, mnemeVersion: "0.0.0" });
    corpusWriter.append({
      type: "workflow_step_applied",
      run_id: GHOST_RUN_ID,
      branch: "main",
      phase_id: "phase-one",
      result_kind: "recall",
      step_id: null,
      outcome: null,
      attempt: null,
      gates: null,
      harvested_n: null,
    });
    const before = snapshotEvents(bench.eventsDir);

    const answers = [
      await call(bench, "diary_facts", { run_id: "../not-a-run" }),
      await call(bench, "diary_facts", { run_id: UNKNOWN_RUN_ID }),
      await call(bench, "diary_facts", { run_id: GHOST_RUN_ID }),
      await call(bench, "diary_facts", { run_id: runningId }),
      await call(bench, "diary_facts", { run_id: runId, brief: true }),
    ];

    expect(answers).toEqual([
      { text: RUN_ID_INVALID_TEXT, isError: false },
      { text: `No workflow run ${UNKNOWN_RUN_ID} in this corpus. Nothing was written.`, isError: false },
      {
        text: `Run ${GHOST_RUN_ID} cannot be read from the log: workflow_step_applied without a preceding workflow_run_started. Nothing was written.`,
        isError: false,
      },
      {
        text: `Run ${runningId} is still running on branch "main": diary facts describe a finished run. Nothing was written.`,
        isError: false,
      },
      { text: BRIEF_WITH_RUN_ID_TEXT, isError: false },
    ]);
    expect(snapshotEvents(bench.eventsDir)).toEqual(before);
  });
});
