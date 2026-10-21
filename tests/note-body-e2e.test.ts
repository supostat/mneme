import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import type { Corpus } from "../src/corpus";
import { CLIPPED_BODIES_COMPONENT, runDoctor } from "../src/doctor";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { readEvents } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { STAGING_BODY_LABEL } from "../src/mcp-rendering";
import { createServer } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";
import { MAX_BODY_CODE_POINTS, serializeNote } from "../src/note";
import { HARVEST_SOURCE } from "../src/workflow/harvest-artifacts";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The wire test of whole note bodies, end to end on REAL modules: a harvest with one over-limit
// artifact is refused through MCP and leaves nothing behind, the corrected harvest stages a body
// exactly at the limit, staging_list shows that body whole inside one fence, and doctor tells a
// body clipped by an older harvest apart from that legitimate one. The only stand-in is the
// embedder, and it is deterministic; the only seed is the older harvest's note and log line, a state
// the current engine can no longer produce.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NOW = new Date("2026-10-21T10:00:00.000Z");
const fixedClock = () => NOW;
const E2E_TIMEOUT_MS = 60000;
const NOTE_FENCE_BEGIN = /^----- BEGIN MNEME NOTE ([0-9a-f]{16}) -----$/;
const DECISION_PREFIX = 22;

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
  corpus: Corpus;
}

async function openSession(): Promise<Session> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-note-body-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-note-body-e2e-home-"));
  let counter = 1;
  const options: CreateServerOptions = {
    projectRoot,
    corpusHome,
    embeddings: bagClient(),
    idFactory: () => ulid(counter++),
    clock: fixedClock,
  };
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, corpus: await resolveCorpus(projectRoot, { corpusHome }) };
}

async function call(session: Session, name: string, args: Record<string, unknown>) {
  const result = await session.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
  return { text, isError: result.isError === true };
}

function stagedNoteFiles(corpus: Corpus): string[] {
  return readdirSync(corpus.stagingDir).filter((name) => name.endsWith(".md"));
}

function harvestEventCount(corpus: Corpus): number {
  return readEvents(corpus.eventsDir).filter(
    (event) => event.type === "workflow_step_applied" && event.result_kind === "harvest",
  ).length;
}

// The lines between the first BEGIN fence and the END fence of the same nonce.
function firstFencedBlock(listed: string): string[] {
  const lines = listed.split("\n");
  const start = lines.findIndex((line) => NOTE_FENCE_BEGIN.test(line));
  const nonce = NOTE_FENCE_BEGIN.exec(lines[start]!)![1];
  const end = lines.indexOf(`----- END MNEME NOTE ${nonce} -----`);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end);
}

async function runToHarvest(session: Session): Promise<string> {
  const phase = serializePhaseDocument({
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "distil what the phase learned into whole notes",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "green", command: "true", timeoutSeconds: null }],
    knowledge: [],
  });
  const started = await call(session, "workflow_start", {
    phases: [phase],
    steps: [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }],
    max_iterations: 10,
  });
  const runId = /Started workflow run ([0-9A-Z]{26})/.exec(started.text)?.[1];
  if (runId === undefined) throw new Error(`could not read the run id from: ${started.text}`);
  await call(session, "workflow_step", {});
  const harvest = await call(session, "workflow_step", {
    run_id: runId,
    step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" },
  });
  expect(harvest.text).toContain("DIRECTIVE: harvest");
  return runId;
}

// A decision whose rendered body — labels included — is exactly MAX_BODY_CODE_POINTS long and
// spans several lines, so a listing that kept only the first line would visibly fail.
function decisionAtTheLimit(): { decision: string; rationale: string; bodyLines: string[] } {
  const decision = "the staging list shows a staged note whole";
  const head = "a curator decides on everything a note says\nnot only on its first line\n";
  const filler = "z".repeat(MAX_BODY_CODE_POINTS - DECISION_PREFIX - decision.length - head.length);
  const rationale = `${head}${filler}`;
  return { decision, rationale, bodyLines: `Decision: ${decision}\nRationale: ${rationale}`.split("\n") };
}

function appendLegacyHarvestRemember(corpus: Corpus, noteId: string): void {
  const event = {
    type: "remember",
    session_id: "s-legacy",
    ts: "2026-07-06T10:00:00.000Z",
    mneme_version: "0.1.11",
    schema_version: 18,
    note_id: noteId,
    note_type: "decision",
    body_len: MAX_BODY_CODE_POINTS,
    anchors_n: 1,
    tags_n: 0,
    source: HARVEST_SOURCE,
    dedup: { outcome: "add", nearest_id: null, similarity: null },
  };
  appendFileSync(join(corpus.eventsDir, "2026-07.jsonl"), `${JSON.stringify(event)}\n`);
}

describe("a whole note body, end to end", () => {
  test(
    "a refused harvest leaves no trace, a body at the limit is listed whole, doctor names only the old clip",
    async () => {
      const session = await openSession();
      const runId = await runToHarvest(session);

      // 1. One artifact over the limit refuses the whole harvest through MCP, and nothing is written.
      const refused = await call(session, "workflow_step", {
        run_id: runId,
        harvest_artifacts: [
          { kind: "decision", decision: "fits", rationale: "short", anchors: ["src/a.ts"] },
          {
            kind: "decision",
            decision: "x".repeat(MAX_BODY_CODE_POINTS),
            rationale: "spills",
            anchors: ["src/a.ts"],
          },
        ],
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(
        "harvest artifact 2 (decision) renders to 1528 code points — 28 over the 1500 limit " +
          "(the template prefix takes 22); nothing was staged",
      );
      expect(stagedNoteFiles(session.corpus)).toEqual([]);
      expect(harvestEventCount(session.corpus)).toBe(0);
      expect((await call(session, "workflow_step", {})).text).toContain("DIRECTIVE: harvest");

      // 2. The corrected harvest stages a multi-line body exactly at the limit.
      const atLimit = decisionAtTheLimit();
      const closed = await call(session, "workflow_step", {
        run_id: runId,
        harvest_artifacts: [
          { kind: "decision", decision: atLimit.decision, rationale: atLimit.rationale, anchors: ["src/a.ts"] },
        ],
      });
      expect(closed.text).toContain("the phase is closed");
      expect(stagedNoteFiles(session.corpus).length).toBe(1);

      // 3. staging_list shows that body whole: the label, then every line, then the fence.
      const block = firstFencedBlock((await call(session, "staging_list", {})).text);
      const label = block.indexOf(STAGING_BODY_LABEL);
      expect(label).toBeGreaterThan(0);
      expect(block.slice(label + 1)).toEqual(atLimit.bodyLines);
      expect([...block.slice(label + 1).join("\n")].length).toBe(MAX_BODY_CODE_POINTS);
      const stagedId = /^id: (\S+)$/.exec(block[0]!)?.[1];
      if (stagedId === undefined) throw new Error(`could not read the staged id from: ${block[0]}`);
      expect((await call(session, "staging_resolve", { id: stagedId, decision: "accept" })).text).toContain(
        `Accepted note ${stagedId}`,
      );

      // 4. doctor recognises the accepted body at the limit as whole ...
      const fresh = await runDoctor({ corpusDir: session.corpus.corpusDir, embedder: bagClient() });
      expect(fresh.components.find((component) => component.name === CLIPPED_BODIES_COMPONENT)).toMatchObject({
        status: "ok",
      });

      // 5. ... and names exactly the note an older harvest clipped.
      const legacyId = ulid(900);
      writeFileSync(
        join(session.corpus.notesDir, `${legacyId}.md`),
        serializeNote({
          frontmatter: {
            id: legacyId,
            type: "decision",
            anchors: ["src/a.ts"],
            commit: "abc1234",
            created: "2026-07-06T10:00:00.000Z",
          },
          body: `Decision: ${"w".repeat(MAX_BODY_CODE_POINTS - 10)}`,
        }),
      );
      appendLegacyHarvestRemember(session.corpus, legacyId);
      const after = await runDoctor({ corpusDir: session.corpus.corpusDir, embedder: bagClient() });
      const clipped = after.components.find((component) => component.name === CLIPPED_BODIES_COMPONENT)!;
      expect(clipped.status).toBe("degraded");
      expect(clipped.detail.startsWith("1 active note(s) were clipped")).toBe(true);
      expect(clipped.detail.endsWith(`: ${legacyId}`)).toBe(true);
      expect(clipped.detail).not.toContain(stagedId);
    },
    E2E_TIMEOUT_MS,
  );
});
