import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { resolveCorpus } from "../corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../embeddings";
import type { EmbeddingsClient } from "../embeddings";
import { EventWriter, readEvents } from "../events";
import { initRepo, runGit } from "../git";
import { openReadOnlyDatabase } from "../index-db";
import { appendSessionStart } from "../mcp-server";
import { recall } from "../recall";
import { remember, REMEMBER_TOOL_SOURCE, stagingResolve } from "../staging";
import type { StagingDeps } from "../staging";
import { workflowStartTool, workflowStepTool } from "../workflow/mcp-tools";
import { serializePhaseDocument } from "../workflow/phase-document";
import { DIARY_TAG, runTag } from "./diary-entries";
import { lastTerminalRunOf, runFacts } from "./diary-run-facts";
import { liveSessionIds, sessionFacts } from "./diary-session-facts";

// The smoke test of the diary's folds against the REAL producers of the events they read: a run
// driven through the workflow tools (a red gate, a retry, a harvest of two kinds), a hand-written
// diary note through remember, a human accept through stagingResolve, a session opened through
// appendSessionStart, and a manual recall that finds nothing. If a producer drops or renames a key
// the folds depend on, this file — not a hand-built fixture — is where it shows.

const fixedClock = () => new Date("2026-10-30T10:00:00.000Z");
const SESSION_ID = "s-producers";
const MARKER_FILE = "gate.marker";

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

async function buildDeps(): Promise<StagingDeps> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-diary-producers-proj-"));
  await initRepo(projectRoot);
  writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const corpus = await resolveCorpus(projectRoot, { corpusHome: mkdtempSync(join(tmpdir(), "mneme-diary-producers-home-")), clock: fixedClock });
  return {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => crypto.randomUUID(),
    embeddings: bagClient(),
    eventWriter: new EventWriter(corpus.eventsDir, { sessionId: SESSION_ID, clock: fixedClock, mnemeVersion: "0.0.0" }),
  };
}

function resultText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

function phaseText(): string {
  return serializePhaseDocument({
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "Wire the ledger reconciliation",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "the marker exists", command: `test -f ${MARKER_FILE}`, timeoutSeconds: null }],
    knowledge: [],
  });
}

async function driveRunToCompletion(deps: StagingDeps): Promise<string> {
  const startText = resultText(await workflowStartTool(deps, {
    phases: [phaseText()],
    steps: [{ id: "implement", max_attempts: 2, on_fail: { action: "escalate" } }],
    max_iterations: 10,
  }));
  const runId = startText.match(/Started workflow run (\S+) on branch/)![1]!;
  await workflowStepTool(deps, {});
  const red = resultText(await workflowStepTool(deps, {
    run_id: runId,
    step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" },
  }));
  expect(red).toContain("FAIL");
  writeFileSync(join(deps.projectRoot, MARKER_FILE), "");
  const green = resultText(await workflowStepTool(deps, {
    run_id: runId,
    step_result: { phase_id: "phase-one", step_id: "implement", attempt: 2, outcome: "success" },
  }));
  expect(green).toContain("PASS");
  await workflowStepTool(deps, {
    run_id: runId,
    harvest_artifacts: [
      { kind: "decision", decision: "reconcile the ledger nightly", rationale: "the bank feed lands at midnight", anchors: ["a.ts"] },
      { kind: "fixed_test", test: "ledger totals match", failure: "rounding drift", fix: "integer cents", anchors: ["a.ts"] },
    ],
    used_notes: [],
  });
  return runId;
}

describe("the diary folds read what the real producers write", () => {
  test("a run driven through the workflow tools yields its facts, curation and diary entry", async () => {
    const deps = await buildDeps();
    const runId = await driveRunToCompletion(deps);
    const stagedBugfix = readEvents(deps.corpus.eventsDir).find(
      (event) => event.type === "remember" && event.note_type === "bugfix",
    )!;
    await stagingResolve(deps, String(stagedBugfix.note_id), "accept");
    await remember(deps, {
      type: "decision",
      body: "Retro: the gate went red once because the marker was missing.",
      anchors: [],
      tags: [DIARY_TAG, runTag(runId)],
      source: REMEMBER_TOOL_SOURCE,
    });

    const answer = runFacts(readEvents(deps.corpus.eventsDir), runId);

    if (answer.kind !== "facts") throw new Error(`expected facts, got ${answer.kind}`);
    expect(answer.facts.status).toBe("complete");
    expect(answer.facts.diaryEntry).toBe(true);
    expect(answer.facts.curation).toEqual({ staged: 1, accepted: 1, rejected: 0, superseded: 0, uninstrumentedHarvests: 0 });
    expect(answer.facts.phases).toEqual([
      {
        phaseId: "phase-one",
        reached: true,
        attempts: 2,
        bundleGap: true,
        harvest: { kind: "run", stagedByType: [{ type: "bugfix", count: 1 }, { type: "decision", count: 1 }], harvestedCount: 2, usedNotes: 0 },
        gateFailures: [{ attempt: 1, kind: "executable", criterion: "the marker exists", reason: "exit-nonzero", remarks: [] }],
      },
    ]);
    expect(lastTerminalRunOf(readEvents(deps.corpus.eventsDir), "main")).toEqual({ runId, status: "complete", diaryEntry: true });
  });

  test("a session opened by appendSessionStart is live, and its manual recall gap stays open until a note", async () => {
    const deps = await buildDeps();
    await driveRunToCompletion(deps);
    appendSessionStart(deps.eventWriter);
    const db = openReadOnlyDatabase(deps.corpus.indexPath);
    try {
      const recalled = await recall(
        { db, embeddings: deps.embeddings, eventWriter: deps.eventWriter, clock: deps.clock },
        "quantum chromodynamics lattice",
        2000,
        "tool-call",
        [],
      );
      expect(recalled.gap).toBe(true);
    } finally {
      db.close();
    }

    expect(liveSessionIds(readEvents(deps.corpus.eventsDir), () => true)).toEqual([SESSION_ID]);
    const before = sessionFacts(readEvents(deps.corpus.eventsDir), SESSION_ID);
    expect(before.gaps).toEqual([{ ts: "2026-10-30T10:00:00.000Z", query: "quantum chromodynamics lattice", open: true }]);
    expect(before.notes).toBe(0);

    await remember(deps, { type: "decision", body: "Lattice QCD is out of scope here.", anchors: ["a.ts"], source: REMEMBER_TOOL_SOURCE });

    const after = sessionFacts(readEvents(deps.corpus.eventsDir), SESSION_ID);
    expect(after.notes).toBe(1);
    expect(after.gaps.map((gap) => gap.open)).toEqual([false]);
  });
});
