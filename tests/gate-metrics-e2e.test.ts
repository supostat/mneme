import { test, expect, setDefaultTimeout } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCorpus } from "../src/corpus";
import type { EmbeddingsClient } from "../src/embeddings";
import { EventWriter, readEvents } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { createServer } from "../src/mcp-server";
import type { CreateServerOptions } from "../src/mcp-server";

// The human-gate metrics lifecycle on REAL modules end-to-end: a plan-fan remember, a shown queue,
// a batch accept riding one curation menu, an accept after an on-disk edit, a reject, a second
// session that falls silent, and a legacy pre-v14 tail — all flowing into the stats gate section.
// The ONLY mock is the embeddings client; the MCP transport, staging, git, index and reader are real.

setDefaultTimeout(60_000);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(from: number): () => string {
  let counter = from;
  return () => ulid(counter++);
}

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

async function buildProjectRepo(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-gate-e2e-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "-A"]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gate-e2e-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((part) => part.text).join("\n");
}

function expectNeutral(response: string): void {
  expect(response.toLowerCase()).not.toContain("menu");
  expect(response.toLowerCase()).not.toContain("agreement");
}

const MENU_BATCH = { decision_class: "curation", options_n: 4, recommended_position: 2, chosen_position: 2 };
const MENU_FAN = { decision_class: "plan-fan", options_n: 3, recommended_position: 2, chosen_position: 2 };

test("the gate-metrics main path flows from instrumented calls into the stats section", async () => {
  const projectRoot = await buildProjectRepo();
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-gate-e2e-home-"));
  let nowMs = Date.parse("2026-08-18T10:00:00.000Z");
  const clock = () => new Date(nowMs);

  // A legacy pre-v14 tail, byte-appended the way a real old log carries it: aggregation must not
  // choke on it and coverage must report it OUTSIDE the instrumented-era denominator.
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock });
  appendFileSync(
    join(corpus.eventsDir, "2026-01.jsonl"),
    JSON.stringify({ type: "note_staged", note_id: ulid(90), session_id: "s-old", ts: "2026-01-05T10:00:00.000Z", schema_version: 1 }) + "\n" +
      JSON.stringify({ type: "note_accepted", note_id: ulid(90), session_id: "s-old", ts: "2026-01-05T10:01:00.000Z", schema_version: 1 }) + "\n",
  );

  const reviewSession = await connect({
    projectRoot,
    corpusHome,
    embeddings: offlineClient(),
    idFactory: sequentialIds(0),
    clock,
  });
  const batchFirst = ulid(1);
  const batchSecond = ulid(2);
  const editedNote = ulid(3);
  const rejectedNote = ulid(4);
  const deferredNote = ulid(5);

  // Session 1 — five notes staged; the first rides a plan-fan menu (the plan skill's Step-8 call).
  const fanResponse = await callText(reviewSession, "remember", {
    type: "decision",
    body: "chose the piggyback design",
    anchors: ["src/a.ts"],
    menu: MENU_FAN,
  });
  expectNeutral(fanResponse);
  nowMs += 1000;
  await callText(reviewSession, "remember", { type: "pattern", body: "batch note two", anchors: ["src/a.ts"] });
  nowMs += 1000;
  await callText(reviewSession, "remember", { type: "bugfix", body: "note to be edited", anchors: ["src/a.ts"] });
  nowMs += 1000;
  await callText(reviewSession, "remember", { type: "antipattern", body: "note to be rejected", anchors: ["src/a.ts"] });
  nowMs += 1000;
  await callText(reviewSession, "remember", { type: "pattern", body: "note left in the queue", anchors: ["src/a.ts"] });

  // The queue is shown — the sitting opens.
  nowMs += 5000;
  await callText(reviewSession, "staging_list", {});

  // Batch accept: two calls, one identical curation menu, chosen == recommended.
  nowMs += 30_000;
  const acceptResponse = await callText(reviewSession, "staging_resolve", { id: batchFirst, decision: "accept", menu: MENU_BATCH });
  expectNeutral(acceptResponse);
  nowMs += 1000;
  await callText(reviewSession, "staging_resolve", { id: batchSecond, decision: "accept", menu: MENU_BATCH });

  // Accept after an on-disk edit of the staged file: the body grows, the heuristic must see it.
  const stagedPath = join(corpus.stagingDir, `${editedNote}.md`);
  writeFileSync(stagedPath, readFileSync(stagedPath, "utf8") + "\nhand-tuned before accepting\n");
  nowMs += 1000;
  await callText(reviewSession, "staging_resolve", { id: editedNote, decision: "accept" });

  nowMs += 1000;
  const rejectResponse = await callText(reviewSession, "staging_resolve", { id: rejectedNote, decision: "reject" });
  expectNeutral(rejectResponse);

  // Session 2 — the queue is shown again (the deferred note), nobody answers.
  nowMs += 60_000;
  const silentSession = await connect({
    projectRoot,
    corpusHome,
    embeddings: offlineClient(),
    idFactory: sequentialIds(50),
    clock,
  });
  await callText(silentSession, "staging_list", {});

  // A next session starts — that closes both the silent sitting and the deferred note's session.
  nowMs += 100_000;
  new EventWriter(corpus.eventsDir, { sessionId: "s-next", mnemeVersion: "0.0.0-e2e", clock }).append({
    type: "session_start",
  });

  nowMs += 1000;
  const stats = await callText(silentSession, "stats", {});

  expect(stats).toContain(
    "(g) Resolution outcomes: accepted as-is 2, accepted after edit 1, rejected 1, superseded 0, " +
      "deferred 1, silence episodes 1, accepted pre-instrumentation 1",
  );
  expect(stats).toContain("(h) Recommendation agreement: 1/1 overall [curation rec@2/4: 1/1]");
  expect(stats).toContain("(i) Menu coverage: 2/4 resolves carry a menu; pre-instrumentation: 1 events");
  expect(stats).toContain("(j) Active review latency: median 30000 ms, p90 30000 ms (1 sittings)");

  // The plan-fan menu landed on the remember event itself — write-only telemetry, never rendered.
  const events = readEvents(corpus.eventsDir);
  const fanRemember = events.find((event) => event.type === "remember" && event.note_id === batchFirst);
  expect(fanRemember?.menu).toEqual(MENU_FAN);
  const deferredResolves = events.filter((event) => event.type === "staging_resolve" && event.note_id === deferredNote);
  expect(deferredResolves.length).toBe(0);
});
