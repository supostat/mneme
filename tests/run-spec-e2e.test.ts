import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "../src/embeddings";
import type { EmbeddingsClient } from "../src/embeddings";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import { WORKFLOW_PHASE_DIR } from "../src/workflow/migration";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The wire test of the run's spec, end to end on the real modules through the MCP surface of a real
// server: a spec with Knowledge is migrated into a corpus named by .mneme.json, listed and read by
// slug, a run is started by that slug, its spec is read back at once, the run is driven to complete
// through two green gates, the diary names its spec and base commit, the phase folder is removed and
// the spec migrated again with other Knowledge — and the run still answers what it started with —
// and a run started from texts says it has no spec. The corpus is proven byte-identical around every
// read. The only stand-in is the embedder.

setDefaultTimeout(60_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EM_DASH = String.fromCharCode(0x2014);
const CORPUS_NAME = "run-spec-e2e";
const SPEC_FILE = "e2e-spec.md";
const SPEC_SLUG = "e2e-spec";
const STEPS = [{ id: "implement", max_attempts: 2, on_fail: { action: "escalate" } }];
const PHASE_IDS = ["first-phase", "second-phase"];
const NOTICE = "Nothing was written: no event, no file, no stale mark.";
const fixedClock = () => new Date("2026-11-18T10:00:00.000Z");
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sequentialIds(): () => string {
  let counter = 0;
  return () => {
    const n = counter++;
    return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
  };
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

// A two-phase spec whose phases gate on `true`, so the run completes on its first attempts; the
// Knowledge bullet continues on a second line so the folded form is observable.
function specText(knowledgeLead: string): string {
  return [
    "# Knowledge",
    "",
    `- **Rule.** ${knowledgeLead}`,
    "  across two lines.",
    "",
    "# Gameplan",
    "",
    `### Phase 1: first phase ${EM_DASH} do the first thing`,
    "",
    "- [ ] do the first thing",
    "",
    "**Done when (EXECUTABLE):**",
    "```",
    "true",
    "```",
    "the first gate is green.",
    "",
    `### Phase 2: second phase ${EM_DASH} do the second thing (order-only после фазы 1)`,
    "",
    "- [ ] do the second thing",
    "",
    "**Done when (EXECUTABLE):**",
    "```",
    "true",
    "```",
    "the second gate is green.",
    "",
  ].join("\n");
}

async function buildProject(): Promise<string> {
  const projectRoot = tempDir("mneme-run-spec-e2e-proj-");
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(projectRoot, ".mneme.json"), JSON.stringify({ corpus: { name: CORPUS_NAME } }));
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

async function connect(projectRoot: string, corpusHome: string): Promise<Client> {
  const server = createServer({ projectRoot, corpusHome, embeddings: bagClient(), idFactory: sequentialIds(), clock: fixedClock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

// Every regular file under the corpus with the sha256 of its bytes — the corpus's own .git included.
function snapshotTree(rootDir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) snapshot.set(relative(rootDir, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(rootDir);
  return snapshot;
}

// A read-only call through the client, with the corpus proven byte-identical around it.
async function readUntouched(client: Client, corpusDir: string, name: string, args: Record<string, unknown>): Promise<string[]> {
  const before = snapshotTree(corpusDir);
  const text = await callText(client, name, args);
  expect(snapshotTree(corpusDir)).toEqual(before);
  return text.split("\n");
}

function runIdOf(startText: string): string {
  const match = /Started workflow run (\S+) on branch/.exec(startText);
  if (match === null) throw new Error(`workflow_start did not report a run id:\n${startText}`);
  return match[1]!;
}

// Each phase: begin it (its recall drains), pass its gate on attempt 1, close it with an empty harvest.
async function driveToComplete(client: Client, runId: string): Promise<string> {
  let last = "";
  for (const phaseId of PHASE_IDS) {
    expect(await callText(client, "workflow_step", {})).toContain(`phase: ${phaseId}`);
    const gated = await callText(client, "workflow_step", {
      run_id: runId,
      step_result: { phase_id: phaseId, step_id: "implement", attempt: 1, outcome: "success" },
    });
    expect(gated).toContain(`Gate verdict for ${phaseId}/implement (attempt 1): PASS`);
    last = await callText(client, "workflow_step", { run_id: runId, harvest_artifacts: [], used_notes: [] });
  }
  return last;
}

describe("a run's spec, end to end", () => {
  test("migrated, started by slug, read back at once, completed, named in the diary, and unchanged by a second migration", async () => {
    const projectRoot = await buildProject();
    const corpusHome = tempDir("mneme-run-spec-e2e-home-");
    const projectHead = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await runGit(projectRoot, ["branch", "--show-current"])).stdout.trim();
    const corpusDir = (await resolveCorpus(projectRoot, { corpusHome, corpusName: CORPUS_NAME })).corpusDir;
    expect(corpusDir).toBe(join(corpusHome, CORPUS_NAME));
    const client = await connect(projectRoot, corpusHome);
    const startKnowledge = "- **Rule.** read the archive across two lines.";
    const phaseLines = [
      "phase first-phase · deps none",
      "- executable: true — the first gate is green.",
      "phase second-phase · deps first-phase",
      "- executable: true — the second gate is green.",
    ];

    // 1. Migrate, then list and read the spec by slug — the engine finds the corpus by its name.
    writeFileSync(join(projectRoot, SPEC_FILE), specText("read the archive"));
    expect(await callText(client, "workflow_migrate", { spec_path: SPEC_FILE, apply: true })).toContain("wrote 2");
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG))).toBe(true);
    expect(await readUntouched(client, corpusDir, "workflow_spec", {})).toEqual([
      `Migrated specs in this corpus: 1. ${NOTICE}`,
      `- ${SPEC_SLUG} · 2 phases`,
    ]);
    expect(await readUntouched(client, corpusDir, "workflow_spec", { spec_slug: SPEC_SLUG })).toEqual([
      `Migrated spec "${SPEC_SLUG}" as it is in this corpus now. ${NOTICE}`,
      "knowledge:",
      startKnowledge,
      ...phaseLines,
    ]);

    // 2. Start by slug and read the run's spec at once: the Knowledge an agent needs before the work.
    const runId = runIdOf(await callText(client, "workflow_start", { spec_slug: SPEC_SLUG, steps: STEPS, max_iterations: 20 }));
    const runSpec = [
      `Spec of run ${runId} on branch "${branch}". ${NOTICE}`,
      `spec ${SPEC_SLUG} · base commit ${projectHead}`,
      "knowledge:",
      startKnowledge,
      ...phaseLines,
    ];
    expect(await readUntouched(client, corpusDir, "workflow_spec", { run_id: runId })).toEqual(runSpec);

    // 3. Drive the run to complete; the diary names its spec and base commit after the status line.
    expect(await driveToComplete(client, runId)).toContain("RUN COMPLETE");
    const diary = await readUntouched(client, corpusDir, "diary_facts", { run_id: runId });
    expect(diary[1]).toStartWith("status complete · ");
    expect(diary[2]).toBe(`spec ${SPEC_SLUG} · base commit ${projectHead}`);

    // 4. Remove the phase folder and migrate the spec again with other Knowledge: the run still answers
    // what it started with, while the slug shows the new text.
    rmSync(join(corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG), { recursive: true });
    writeFileSync(join(projectRoot, SPEC_FILE), specText("a rewritten rule"));
    expect(await callText(client, "workflow_migrate", { spec_path: SPEC_FILE, apply: true })).toContain("wrote 2");
    expect(await readUntouched(client, corpusDir, "workflow_spec", { run_id: runId })).toEqual(runSpec);
    expect((await readUntouched(client, corpusDir, "workflow_spec", { spec_slug: SPEC_SLUG }))[2]).toBe(
      "- **Rule.** a rewritten rule across two lines.",
    );

    // 5. A run started from texts says it has no spec, and still records the project HEAD.
    const inlinePhase = serializePhaseDocument({
      id: "inline-phase",
      deps: [],
      agentRole: "coder",
      description: "Work from a text",
      tasks: ["do the work"],
      doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
      knowledge: [],
    });
    const inlineRunId = runIdOf(await callText(client, "workflow_start", { phases: [inlinePhase], steps: STEPS, max_iterations: 20 }));
    expect((await readUntouched(client, corpusDir, "workflow_spec", { run_id: inlineRunId })).slice(1, 3)).toEqual([
      `spec none · base commit ${projectHead}`,
      "knowledge: none — phases were passed as text",
    ]);
  });
});
