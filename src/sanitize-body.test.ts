import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, initRepo } from "./git";
import { resolveCorpus } from "./corpus";
import { EventWriter } from "./events";
import type { EmbeddingsClient } from "./embeddings";
import { remember } from "./staging";
import type { StagingDeps } from "./staging";
import { assertCleanNoteBody, findForbiddenMarkup, ForbiddenMarkupError } from "./sanitize-body";

// Dangerous tokens are assembled from pieces so this test file never carries a live tool-calling tag,
// harness tag, or raw framing-breaking character as source text.
const OPEN = "<";
const CLOSE = "/";
const GT = ">";
const closingInvokeTag = OPEN + CLOSE + "invoke" + GT;
const closingBodyTag = OPEN + CLOSE + "body" + GT;
const openingParameterTag = OPEN + "parameter name=" + '"x"' + GT;
const openingSystemReminderTag = OPEN + "system-reminder" + GT;
const lineSeparator = String.fromCharCode(0x2028);
const mcpEndFence = "END MNEME NOTE";

describe("findForbiddenMarkup rejects foreign protocol markup", () => {
  test("flags a function-calling closing tag", () => {
    const body = "captures the retry loop\nsee " + closingInvokeTag + " boundary";
    expect(findForbiddenMarkup(body)).not.toBeNull();
  });

  test("flags an opening function-calling parameter tag", () => {
    expect(findForbiddenMarkup("uses " + openingParameterTag + " here")).not.toBeNull();
  });

  test("flags an HTML skeleton closing tag", () => {
    expect(findForbiddenMarkup("page ends with " + closingBodyTag)).not.toBeNull();
  });

  test("flags a harness system-reminder tag", () => {
    expect(findForbiddenMarkup("injected " + openingSystemReminderTag + " frame")).not.toBeNull();
  });

  test("flags the forgeable MCP note-fence literal", () => {
    expect(findForbiddenMarkup("body smuggling a " + mcpEndFence + " delimiter")).toBe(mcpEndFence);
  });

  test("flags a framing-breaking invisible character", () => {
    expect(findForbiddenMarkup("split" + lineSeparator + "across frames")).toBe("U+2028");
  });

  test("assertCleanNoteBody throws a typed error naming the token", () => {
    expect(() => assertCleanNoteBody("bad " + closingInvokeTag)).toThrow(ForbiddenMarkupError);
  });
});

describe("findForbiddenMarkup leaves legitimate code fragments untouched", () => {
  const legitimateBodies = [
    "renders a <div> wrapper around the list",
    "the <Component /> takes a single prop",
    "signature is Array<string> not any[]",
    "cache keyed by Map<K, V> across sessions",
    "guard runs only when if (a < b && c > d)",
    "prose about a decision with no markup at all",
    "```ts\nconst n: number = 1\n```",
    "avoids <header> and <bodyguard> false positives",
  ];

  for (const body of legitimateBodies) {
    test(`passes: ${body.slice(0, 32)}`, () => {
      expect(findForbiddenMarkup(body)).toBeNull();
      expect(() => assertCleanNoteBody(body)).not.toThrow();
    });
  }

  test("returns the body byte-identical intent: validator never mutates", () => {
    const body = "signature is Map<K, V>";
    assertCleanNoteBody(body);
    expect(body).toBe("signature is Map<K, V>");
  });
});

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[0]! + CROCKFORD[1]!;
}

const fixedClock = (): Date => new Date("2026-07-06T10:00:00.000Z");

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

async function buildProjectRepo(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-sanitize-body-proj-"));
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

async function makeDeps(projectRoot: string): Promise<StagingDeps> {
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-sanitize-body-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-sanitize-body",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  return { corpus, projectRoot, clock: fixedClock, idFactory: ulid, embeddings: offlineClient(), eventWriter };
}

describe("remember write path rejects poisoned bodies before staging", () => {
  test("a body with a tool-calling closing tag never reaches staging", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);
    const poisoned = "reproduces the corruption\nthen " + closingInvokeTag;

    await expect(
      remember(deps, { type: "bugfix", body: poisoned, anchors: ["src/a.ts"], source: "mcp" }),
    ).rejects.toThrow(ForbiddenMarkupError);
    expect(readdirSync(deps.corpus.stagingDir)).toEqual([]);
  });

  test("a clean body is still staged normally", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot);

    const result = await remember(deps, {
      type: "pattern",
      body: "graceful shutdown drains the queue with Map<K, V> state",
      anchors: ["src/a.ts"],
      source: "mcp",
    });

    expect(result.outcome).toBe("staged");
    expect(readdirSync(deps.corpus.stagingDir).some((name) => name.endsWith(".md"))).toBe(true);
  });
});
