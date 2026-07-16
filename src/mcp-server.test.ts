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
import { EMBEDDING_DIMENSION } from "./embeddings";
import { createServer, createSessionEndHandler } from "./mcp-server";
import type { CreateServerOptions } from "./mcp-server";
import { eventSchema } from "./event-schema";

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
  return { embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }) };
}

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

function keyedClient(byBody: Map<string, number[]>): EmbeddingsClient {
  return {
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
  test("exposes exactly the eight mneme tools", async () => {
    const client = await connect({
      projectRoot: await buildProjectRepo(),
      corpusHome: corpusHomeDir(),
      embeddings: offlineClient(),
      idFactory: sequentialIds(),
      clock: fixedClock,
    });

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "recall",
      "remember",
      "staging_list",
      "staging_resolve",
      "stats",
      "workflow_migrate",
      "workflow_start",
      "workflow_step",
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
    // The stats tool concatenates formatStats + formatFriction + formatFootprint; pin both extra
    // sections so dropping either concatenation line fails here instead of staying green.
    expect(stats).toContain("(d) Staged -> resolved latency:");
    expect(stats).toContain("(g) Total size:");
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
