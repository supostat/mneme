import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runGit, initRepo } from "./git";
import { resolveCorpus } from "./corpus";
import { EventWriter, readEvents } from "./events";
import type { EmbeddingsClient } from "./embeddings";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./embeddings";
import { createServer, createSessionEndHandler } from "./mcp-server";
import type { CreateServerOptions } from "./mcp-server";
import { eventSchema } from "./event-schema";
import { formatResolve, STAGING_BODY_LABEL } from "./mcp-rendering";
import type { IndexRefresh } from "./index-refresh";
import type { ResolveResult } from "./staging";
import { MAX_BODY_CODE_POINTS } from "./note";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(): () => string {
  let counter = 0;
  return () => ulid(counter++);
}

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

async function buildProjectRepo(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-mcp-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/a.ts"), "content\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
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

function offlineClient(): EmbeddingsClient {
  return {
    model: EMBEDDING_MODEL,
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

function keyedClient(byBody: Map<string, number[]>): EmbeddingsClient {
  return {
    model: EMBEDDING_MODEL,
    embed: async (inputs) => {
      if (inputs.length === 0) return { available: true, embeddings: [], retries: 0 };
      return {
        available: true,
        embeddings: inputs.map((body) => {
          const components = byBody.get(body);
          if (components === undefined) throw new Error(`no vector for body: ${body}`);
          const vector = new Float32Array(EMBEDDING_DIMENSION);
          components.forEach((value, index) => {
            vector[index] = value;
          });
          return vector;
        }),
        retries: 0,
      };
    },
  };
}

async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((part) => part.text).join("\n");
}

function corpusHomeDir(): string {
  return mkdtempSync(join(tmpdir(), "mneme-mcp-home-"));
}

// The BEGIN/END fences carry a random per-response nonce so a note body cannot forge the closing
// delimiter; a response shares one nonce across every block, so BEGIN and END must agree.
function expectNonceFences(text: string): void {
  const begin = text.match(/----- BEGIN MNEME NOTE ([0-9a-f]{16}) -----/);
  const end = text.match(/----- END MNEME NOTE ([0-9a-f]{16}) -----/);
  expect(begin).not.toBeNull();
  expect(end).not.toBeNull();
  expect(begin![1]).toBe(end![1]);
}

// createServer draws the session id from idFactory first, so the first staged note is ulid(1).

describe("mcp-server tool surface", () => {
  test("exposes exactly the fifteen mneme tools", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "anchor_repair",
      "anchor_sweep",
      "corpus_adopt",
      "note_retire",
      "notes_list",
      "recall",
      "remember",
      "staging_list",
      "staging_resolve",
      "stats",
      "workflow_abandon",
      "workflow_migrate",
      "workflow_start",
      "workflow_step",
      "workflow_survey",
    ]);
  });
});

describe("mcp-server remember description nudge", () => {
  test("remember description nudges pattern notes toward a generalized body and example anchors", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const tools = await client.listTools();
    const remember = tools.tools.find((tool) => tool.name === "remember");

    expect(remember).toBeDefined();
    const description = (remember!.description ?? "").toLowerCase();
    expect(description).toContain("pattern");
    expect(description).toContain("example");
    expect(description).toContain("generaliz");
  });
});

describe("mcp-server full cycle", () => {
  const acceptedBody = "wal lock contention during concurrent rebuild";
  const rejectedBody = "telemetry sampling heuristic for hot paths";

  test("remember stages two notes, accept one and reject the other, recall returns only the accepted note", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: bagClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const acceptedId = ulid(1);
    const rejectedId = ulid(2);

    const remembered = await callText(client, "remember", {
      type: "pattern",
      body: acceptedBody,
      anchors: ["src/a.ts"],
    });
    expect(remembered).toContain(acceptedId);
    expect(remembered).toContain("staging_list");
    await callText(client, "remember", { type: "antipattern", body: rejectedBody, anchors: ["src/a.ts"] });

    const listed = await callText(client, "staging_list", {});
    expect(listed).toContain("retrieved DATA");
    expectNonceFences(listed);
    expect(listed).toContain(acceptedId);
    expect(listed).toContain(rejectedId);

    expect(await callText(client, "staging_resolve", { id: acceptedId, decision: "accept" })).toContain("Accepted");
    expect(await callText(client, "staging_resolve", { id: rejectedId, decision: "reject" })).toContain("Rejected");

    const recalled = await callText(client, "recall", { query: acceptedBody, budget: 2000 });
    expect(recalled).toContain("retrieved DATA");
    expectNonceFences(recalled);
    expect(recalled).toContain(acceptedBody);
    expect(recalled).not.toContain(rejectedBody);
  });

  test("remember accepts tags through the tool schema and staging_list renders them", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const remembered = await callText(client, "remember", {
      type: "decision",
      body: "soft-delete concept note over MCP",
      anchors: [],
      tags: ["soft-delete", "ticket_groups.terminal_at"],
    });
    expect(remembered).toContain("Staged note");

    const listed = await callText(client, "staging_list", {});
    expect(listed).toContain("anchors: (none)");
    expect(listed).toContain("tags: soft-delete, ticket_groups.terminal_at");
    expect(listed).toContain("note: no path anchors");
  });
});

describe("mcp-server empty responses", () => {
  test("staging_list on a fresh server reports the empty queue", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const listed = await callText(client, "staging_list", {});

    expect(listed).toBe("The staging queue is empty. Nothing to review.");
  });

  test("recall reports no matches when a populated index matches neither channel", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: bagClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const noteId = ulid(1);
    await callText(client, "remember", { type: "pattern", body: "singleton lifecycle ownership", anchors: ["src/a.ts"] });
    await callText(client, "staging_resolve", { id: noteId, decision: "accept" });

    // "%%% ---" yields no FTS terms and a zero-norm bag vector, so both channels stay empty while a
    // stored vector keeps recall out of degraded mode: the exact non-degraded no-match string.
    const recalled = await callText(client, "recall", { query: "%%% ---", budget: 2000 });

    expect(recalled).toBe("No matching notes.");
  });
});

describe("mcp-server supersede path", () => {
  const targetBody = "original decision rationale about retries";
  const newBody = "revised decision rationale about retries";

  test("supersede via the tool commits the new note and recall drops the superseded target", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const embeddings = keyedClient(new Map([[targetBody, [1, 0]], [newBody, [75, 40]]]));
    const client = await connect({ projectRoot, corpusHome, embeddings, idFactory: sequentialIds(), clock: fixedClock });
    const targetId = ulid(1);
    const newId = ulid(2);

    await callText(client, "remember", { type: "decision", body: targetBody, anchors: ["src/a.ts"] });
    await callText(client, "staging_resolve", { id: targetId, decision: "accept" });
    await callText(client, "remember", { type: "decision", body: newBody, anchors: ["src/a.ts"] });
    const resolved = await callText(client, "staging_resolve", {
      id: newId,
      decision: "supersede",
      supersede_target: targetId,
    });
    expect(resolved).toContain("Superseded");

    const recalled = await callText(client, "recall", { query: newBody, budget: 100000 });
    expect(recalled).toContain(newBody);
    expect(recalled).not.toContain(targetBody);

    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const superseded = readEvents(corpus.eventsDir).filter(
      (event) => event.type === "staging_resolve" && event.decision === "supersede",
    );
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.note_id).toBe(newId);
    expect(superseded[0]!.superseded_id).toBe(targetId);
  });
});

describe("mcp-server staging digest", () => {
  test("renders anchors with liveness and an honest degraded dedup state", async () => {
    const projectRoot = await buildProjectRepo();
    writeFileSync(join(projectRoot, "src/fresh.ts"), "created this session\n");
    const client = await connect({
      projectRoot,
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    await callText(client, "remember", {
      type: "pattern",
      body: "digest render",
      anchors: ["src/a.ts", "src/fresh.ts", "src/gone.ts"],
    });

    const listed = await callText(client, "staging_list", {});

    expect(listed).toContain("anchors: src/a.ts [tracked], src/fresh.ts [untracked-exists], src/gone.ts [missing]");
    expect(listed).toContain("dedup: unavailable");
    expect(listed).not.toContain("no close");
  });
});

describe("mcp-server staging full body", () => {
  const FENCE_BEGIN = /^----- BEGIN MNEME NOTE ([0-9a-f]{16}) -----$/;

  // The lines between one BEGIN fence and the END fence of the same nonce: the whole staged entry.
  function firstFencedBlock(listed: string): string[] {
    const lines = listed.split("\n");
    const start = lines.findIndex((line) => FENCE_BEGIN.test(line));
    const nonce = FENCE_BEGIN.exec(lines[start]!)![1];
    const end = lines.indexOf(`----- END MNEME NOTE ${nonce} -----`);
    expect(end).toBeGreaterThan(start);
    return lines.slice(start + 1, end);
  }

  async function listedAfterRemembering(body: string): Promise<string> {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    await callText(client, "remember", { type: "decision", body, anchors: ["src/a.ts"] });
    return callText(client, "staging_list", {});
  }

  test("a multi-line body follows the body label in full, its last line right before the fence", async () => {
    const body = [
      "Decision: keep flat files as the corpus truth",
      "Rationale: the index is a cache",
      "and it rebuilds",
    ].join("\n");

    const block = firstFencedBlock(await listedAfterRemembering(body));

    expect(block.slice(1)).toEqual([
      "type: decision",
      "dedup: unavailable",
      "anchors: src/a.ts [tracked]",
      STAGING_BODY_LABEL,
      "Decision: keep flat files as the corpus truth",
      "Rationale: the index is a cache",
      "and it rebuilds",
    ]);
    expect(block[0]).toMatch(/^id: /);
  });

  test("a body exactly at the limit is listed whole", async () => {
    const body = `Decision: ${"x".repeat(MAX_BODY_CODE_POINTS - 10)}`;

    const block = firstFencedBlock(await listedAfterRemembering(body));

    expect(block.at(-1)).toBe(body);
    expect([...block.at(-1)!].length).toBe(MAX_BODY_CODE_POINTS);
  });
});

describe("mcp-server stats", () => {
  test("stats on a fresh server renders every ratio honestly as n/a", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const stats = await callText(client, "stats", {});

    expect(stats).toContain("Accepted notes (historical): 0");
    expect(stats).toContain("Cross-session reuse: n/a (0 accepted notes)");
    expect(stats).toContain("Recall degradation: n/a (0 recall events)");
    // The stats tool concatenates formatStats + formatFriction + formatGateAudit + formatUseStats +
    // formatFootprint; pin each extra section so dropping any concatenation line fails here instead
    // of staying green.
    expect(stats).toContain("(d) Staged -> resolved latency:");
    expect(stats).toContain("Human gate (from the event log)");
    expect(stats).toContain("(h) Recommendation agreement: n/a (0 instrumented decisions)");
    expect(stats).toContain("Note usefulness (from the event log; self-declared, read as an upper bound)");
    expect(stats).toContain("(k) Total size:");
    expect(stats).toContain("(l) Precision-of-use, all time: no data");
    expect(stats).toContain("(m) Declaration coverage: no data (0 harvests)");
  });

  test("stats renders the gate section from the real reader after an instrumented accept", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const id = ulid(1);
    await callText(client, "remember", { type: "pattern", body: "gate section body", anchors: ["src/a.ts"] });
    await callText(client, "staging_resolve", {
      id,
      decision: "accept",
      menu: { decision_class: "curation", options_n: 4, recommended_position: 2, chosen_position: 2 },
    });

    const stats = await callText(client, "stats", {});

    expect(stats).toContain("(g) Resolution outcomes: accepted as-is 1");
    expect(stats).toContain("(h) Recommendation agreement: 1/1 overall [curation rec@2/4: 1/1]");
    expect(stats).toContain("(i) Menu coverage: 1/1 resolves carry a menu");
  });

  test("a note staged and accepted in one session and recalled later in another reads as cross-session reuse", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const noteBody = "cross session reuse subject matter";
    const acceptingSession = await connect({
      projectRoot,
      corpusHome,
      embeddings: bagClient(),
      idFactory: sequentialIds(),
      clock: () => new Date("2026-07-06T10:00:00.000Z"),
    });
    const noteId = ulid(1);
    await callText(acceptingSession, "remember", { type: "pattern", body: noteBody, anchors: ["src/a.ts"] });
    await callText(acceptingSession, "staging_resolve", { id: noteId, decision: "accept" });

    let recallingCounter = 0;
    const recallingSession = await connect({
      projectRoot,
      corpusHome,
      embeddings: bagClient(),
      idFactory: () => ulid(50 + recallingCounter++),
      clock: () => new Date("2026-07-06T11:00:00.000Z"),
    });
    const recalled = await callText(recallingSession, "recall", { query: noteBody, budget: 2000 });
    expect(recalled).toContain(noteId);

    const stats = await callText(recallingSession, "stats", {});
    expect(stats).toContain("Cross-session reuse: 1/1 (100.0%)");
  });
});

describe("mcp-server error boundary", () => {
  test("an invalid supersede target returns an error result and logs tool_error", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const noteId = ulid(1);
    await callText(client, "remember", { type: "pattern", body: "a note awaiting review", anchors: ["src/a.ts"] });

    const result = await client.callTool({
      name: "staging_resolve",
      arguments: { id: noteId, decision: "supersede", supersede_target: ulid(7) },
    });
    expect(result.isError).toBe(true);

    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const errors = readEvents(corpus.eventsDir).filter((event) => event.type === "tool_error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.tool).toBe("staging_resolve");
    // The message carries no path or secret, so the sanitizer is a no-op and the ULID survives intact.
    expect(errors[0]!.message).toContain(ulid(7));
  });
});

describe("mcp-server gate-metrics menu intake", () => {
  const MENU = { decision_class: "curation", options_n: 4, recommended_position: 2, chosen_position: 1 };

  // The SDK rejects a failed input validation before the handler runs; depending on the transport
  // it surfaces as a thrown McpError or an isError result — both count as a refused call.
  async function callExpectingRefusal(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
    let refused = false;
    try {
      const result = await client.callTool({ name, arguments: args });
      refused = result.isError === true;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }

  test("a valid menu on staging_resolve lands in the on-disk event and passes the producer schema", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const id = ulid(1);
    await callText(client, "remember", { type: "pattern", body: "menu smoke body", anchors: ["src/a.ts"] });

    await callText(client, "staging_resolve", { id, decision: "accept", menu: MENU });

    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const resolved = readEvents(corpus.eventsDir).filter((event) => event.type === "staging_resolve");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.menu).toEqual(MENU);
    expect(resolved[0]!.accepted_body_len).toBe([..."menu smoke body"].length);
    expect(eventSchema.safeParse(resolved[0]!).success).toBe(true);
  });

  test("a plan-fan menu on remember lands in the remember event", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const fanMenu = { decision_class: "plan-fan", options_n: 3, recommended_position: 2, chosen_position: 2 };

    const response = await callText(client, "remember", {
      type: "decision",
      body: "chose the piggyback option",
      anchors: ["src/a.ts"],
      menu: fanMenu,
    });

    expect(response.toLowerCase()).not.toContain("menu");
    expect(response.toLowerCase()).not.toContain("agreement");
    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const remembered = readEvents(corpus.eventsDir).filter((event) => event.type === "remember");
    expect(remembered[0]!.menu).toEqual(fanMenu);
  });

  test("chosen_position beyond options_n refuses the call and writes nothing to the log", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const id = ulid(1);
    await callText(client, "remember", { type: "pattern", body: "stays staged", anchors: ["src/a.ts"] });

    await callExpectingRefusal(client, "staging_resolve", {
      id,
      decision: "accept",
      menu: { ...MENU, chosen_position: 5 },
    });

    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const events = readEvents(corpus.eventsDir);
    expect(events.filter((event) => event.type === "staging_resolve").length).toBe(0);
    expect(events.filter((event) => event.type === "tool_error").length).toBe(0);
  });

  test("an unknown decision_class refuses a remember and stages nothing", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    await callExpectingRefusal(client, "remember", {
      type: "pattern",
      body: "never staged",
      anchors: ["src/a.ts"],
      menu: { ...MENU, decision_class: "commit" },
    });

    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    expect(readEvents(corpus.eventsDir).filter((event) => event.type === "remember").length).toBe(0);
  });
});

describe("mcp-server event schema conformance", () => {
  test("every event emitted across a full cycle validates against the current producer schema", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: bagClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const firstId = ulid(1);
    const secondId = ulid(2);
    const thirdId = ulid(3);

    await callText(client, "remember", { type: "pattern", body: "alpha widget contraption assembly", anchors: ["src/a.ts"] });
    await callText(client, "remember", { type: "antipattern", body: "beta gadget lever hinge", anchors: ["src/a.ts"] });
    await callText(client, "staging_list", {});
    await callText(client, "staging_resolve", { id: firstId, decision: "accept" });
    await callText(client, "staging_resolve", { id: secondId, decision: "reject" });
    await callText(client, "remember", { type: "decision", body: "gamma sprocket flywheel gizmo", anchors: ["src/a.ts"] });
    await callText(client, "staging_resolve", { id: thirdId, decision: "supersede", supersede_target: firstId });
    await callText(client, "recall", { query: "alpha widget", budget: 2000 });
    await callText(client, "stats", {});

    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    const events = readEvents(corpus.eventsDir);
    const types = new Set(events.map((event) => event.type));
    for (const expected of ["remember", "staging_resolve", "staging_listed", "rebuild", "recall"]) {
      expect(types).toContain(expected);
    }
    for (const event of events) {
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error(`event ${String(event.type)} failed schema: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });
});

describe("mcp-server session lifecycle", () => {
  test("the session-end handler appends exactly one session_end even when invoked twice", () => {
    const eventsDir = mkdtempSync(join(tmpdir(), "mneme-mcp-life-"));
    const eventWriter = new EventWriter(eventsDir, { sessionId: "s-life", mnemeVersion: "0.1.0", clock: fixedClock });
    const endSession = createSessionEndHandler(eventWriter);

    endSession();
    endSession();

    const ends = readEvents(eventsDir).filter((event) => event.type === "session_end");
    expect(ends.length).toBe(1);
  });
});

// A committed outcome keeps its own line byte for byte; when the rebuild after the commit failed it
// gains exactly two lines — the reason and the do-not-retry advice — and the call is not an error.
const REBUILD_FAILURE_REASON = "unable to open database file";
const INDEX_NOT_REBUILT_LINE = "Index not rebuilt: unable to open database file";
const CATCH_UP_ADVICE_LINE =
  "The decision is committed — do not retry it; the index catches up on the next successful rebuild.";
const COMMIT = "a".repeat(40);

const COMMITTED_OUTCOME_LINES: Array<{ outcome: string; resultWith: (index: IndexRefresh) => ResolveResult; line: string }> = [
  {
    outcome: "accepted",
    resultWith: (index) => ({ outcome: "accepted", noteId: ulid(1), commit: COMMIT, index }),
    line: `Accepted note ${ulid(1)}; committed ${COMMIT}.`,
  },
  {
    outcome: "superseded",
    resultWith: (index) => ({ outcome: "superseded", noteId: ulid(2), supersededId: ulid(1), commit: COMMIT, suggested: false, index }),
    line: `Superseded ${ulid(1)} with note ${ulid(2)}; committed ${COMMIT}.`,
  },
  {
    outcome: "retired",
    resultWith: (index) => ({ outcome: "retired", requestId: ulid(3), noteId: ulid(1), commit: COMMIT, index }),
    line: `Retired note ${ulid(1)}; the file stays in notes/ as history and left recall. Committed ${COMMIT}.`,
  },
  {
    outcome: "reanchored",
    resultWith: (index) => ({
      outcome: "reanchored",
      requestId: ulid(3),
      noteId: ulid(1),
      oldAnchor: "src/old.ts",
      newAnchor: "src/a.ts",
      commit: COMMIT,
      index,
    }),
    line: `Re-anchored note ${ulid(1)}: src/old.ts -> src/a.ts; committed ${COMMIT}.`,
  },
  {
    outcome: "retagged",
    resultWith: (index) => ({ outcome: "retagged", requestId: ulid(3), noteId: ulid(1), anchor: "MultiSelect", commit: COMMIT, index }),
    line: `Retagged note ${ulid(1)}: MultiSelect moved from anchors to tags; committed ${COMMIT}.`,
  },
];

describe("staging_resolve result when the rebuild fails after the commit", () => {
  for (const { outcome, resultWith, line } of COMMITTED_OUTCOME_LINES) {
    test(`${outcome}: one unchanged line when rebuilt, three lines when the rebuild failed`, () => {
      const rebuilt = resultWith({ rebuilt: true });
      const failed = resultWith({ rebuilt: false, reason: REBUILD_FAILURE_REASON });

      expect(formatResolve(rebuilt)).toBe(line);
      expect(formatResolve(failed).split("\n")).toEqual([line, INDEX_NOT_REBUILT_LINE, CATCH_UP_ADVICE_LINE]);
    });
  }

  test("over MCP the accept succeeds with the three lines, logs rebuild_failed and no tool_error", async () => {
    const projectRoot = await buildProjectRepo();
    const corpusHome = corpusHomeDir();
    const client = await connect({
      projectRoot,
      corpusHome,
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });
    const noteId = ulid(1);
    await callText(client, "remember", { type: "pattern", body: "a note accepted while the index is broken", anchors: ["src/a.ts"] });
    const corpus = await resolveCorpus(projectRoot, { corpusHome });
    mkdirSync(corpus.indexPath);

    const result = await client.callTool({ name: "staging_resolve", arguments: { id: noteId, decision: "accept" } });

    expect(result.isError).toBeFalsy();
    const head = (await runGit(corpus.corpusDir, ["rev-parse", "HEAD"])).stdout.trim();
    const text = (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
    expect(text.split("\n")).toEqual([
      `Accepted note ${noteId}; committed ${head}.`,
      INDEX_NOT_REBUILT_LINE,
      CATCH_UP_ADVICE_LINE,
    ]);
    const events = readEvents(corpus.eventsDir);
    expect(events.filter((event) => event.type === "tool_error")).toEqual([]);
    expect(events.slice(-2).map((event) => event.type)).toEqual(["staging_resolve", "rebuild_failed"]);
    expect(eventSchema.safeParse(events.at(-1)).success).toBe(true);
  });

  test("the staging_resolve description tells the caller not to retry a committed decision", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const tools = await client.listTools();
    const description = tools.tools.find((tool) => tool.name === "staging_resolve")?.description ?? "";

    expect(description).toContain(
      'If the index rebuild fails after the decision is committed, the result says so with an "Index not rebuilt:" ' +
        "line — that is not an error and the decision must not be retried.",
    );
  });
});
