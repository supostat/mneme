import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, initRepo } from "./git";
import { CommitIdentityReadError } from "./commit-identity";
import { defaultConfig } from "./config";
import { resolveCorpus } from "./corpus";
import { CorpusBusyError } from "./corpus-git";
import type { Corpus } from "./corpus";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { parseNote, serializeNote, NoteValidationError } from "./note";
import type { EmbeddingsClient } from "./embeddings";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./embeddings";
import { dumpIndex, rebuild } from "./index-db";
import { noteReanchor, noteRetag, noteRetire } from "./curation";
import { rebuildDeps, remember, stagingList, stagingResolve, StagingError } from "./staging";
import type { ResolveDecision, ResolveResult, StagingDeps } from "./staging";
import { formatStagingList } from "./mcp-rendering";
import { HttpJudgeClient } from "./judge";
import type { JudgeClient } from "./judge";
import type { FetchImplementation } from "./embeddings";

// These tests spawn real git repositories and dozens of git subprocesses per case; under machine
// load the slowest cases exceed bun's 5s default per-test timeout and fail the suite spuriously.
setDefaultTimeout(30_000);

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
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-staging-proj-"));
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

function offlineClient(): EmbeddingsClient {
  return {
    model: EMBEDDING_MODEL,
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

function vectorFrom(components: number[]): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  components.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
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
          return vectorFrom(components);
        }),
        retries: 0,
      };
    },
  };
}

function hashTerm(term: string): number {
  let hash = 2166136261;
  for (let index = 0; index < term.length; index++) {
    hash ^= term.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function bagVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const dimension = hashTerm(term) % EMBEDDING_DIMENSION;
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

async function makeDeps(
  projectRoot: string,
  embeddings: EmbeddingsClient,
  idFactory: () => string,
  clock: () => Date = fixedClock,
  judge?: JudgeClient,
): Promise<StagingDeps> {
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-staging-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-staging",
    mnemeVersion: "0.1.0",
    clock,
  });
  return { corpus, projectRoot, config: defaultConfig(), clock, idFactory, embeddings, eventWriter, judge };
}

function eventsOfType(corpus: Corpus, type: string): StoredEvent[] {
  return readEvents(corpus.eventsDir).filter((event) => event.type === type);
}

const CLOCK_START = "2026-07-06T10:00:00.000Z";
const MONTHLY_EVENT_FILE = "2026-07.jsonl";

interface MutableClock {
  now: () => Date;
  advanceMilliseconds: (milliseconds: number) => void;
}

function mutableClock(): MutableClock {
  let currentMilliseconds = new Date(CLOCK_START).getTime();
  return {
    now: () => new Date(currentMilliseconds),
    advanceMilliseconds: (milliseconds) => {
      currentMilliseconds += milliseconds;
    },
  };
}

// Writes a valid staged note straight to the staging dir WITHOUT emitting a remember/note_staged
// event, so a resolve sees a note whose only (or no) staging anchor is whatever the test injects.
function stageNoteFileWithoutEvent(deps: StagingDeps, id: string, body: string): void {
  const serialized = serializeNote({
    frontmatter: { id, type: "pattern", anchors: ["src/a.ts"], commit: "0".repeat(40), created: CLOCK_START },
    body,
  });
  writeFileSync(join(deps.corpus.stagingDir, `${id}.md`), serialized);
}

// Emits a pre-schema-v2 note_staged line, the legacy name the staged-at anchor lookup must still read.
function appendLegacyNoteStaged(deps: StagingDeps, id: string, stagedAt: string): void {
  const legacyEvent = {
    type: "note_staged",
    note_id: id,
    session_id: "legacy-session",
    ts: stagedAt,
    mneme_version: "0.0.1",
    schema_version: 1,
  };
  appendFileSync(join(deps.corpus.eventsDir, MONTHLY_EVENT_FILE), JSON.stringify(legacyEvent) + "\n");
}

describe("remember staging", () => {
  test("stages an ADD note with a degraded sidecar and emits a remember event", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const body = "graceful shutdown sequence";

    const result = await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"], source: "mcp" });

    expect(result.outcome).toBe("staged");
    if (result.outcome === "staged") {
      expect(result.dedup).toBe("add");
      expect(result.degraded).toBe(true);
      expect(result.nearestId).toBeNull();
    }
    const id = ulid(0);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.dedup.json`))).toBe(true);
    const remembered = eventsOfType(deps.corpus, "remember");
    expect(remembered.length).toBe(1);
    expect(remembered[0]!.note_id).toBe(id);
    expect(remembered[0]!.note_type).toBe("pattern");
    expect(remembered[0]!.body_len).toBe([...body].length);
    expect(remembered[0]!.anchors_n).toBe(1);
    expect(remembered[0]!.source).toBe("mcp");
    expect(remembered[0]!.dedup).toEqual({
      outcome: "add",
      nearest_id: null,
      similarity: null,
      supersede_threshold: 0.85,
      noop_threshold: 0.97,
      degraded: true,
      judge: null,
    });
  });

  test("throws when the project has no resolvable HEAD", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-staging-nohead-"));
    await initRepo(projectRoot);
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await expect(
      remember(deps, { type: "pattern", body: "b", anchors: ["src/a.ts"], source: "mcp" }),
    ).rejects.toThrow(StagingError);
  });

  test("a bad idFactory throws before anything is written to staging", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), () => "not-a-valid-id");

    await expect(
      remember(deps, { type: "pattern", body: "body that must never be staged", anchors: ["src/a.ts"], source: "mcp" }),
    ).rejects.toThrow(StagingError);
    expect(readdirSync(deps.corpus.stagingDir)).toEqual([]);
  });

  test("a near-identical body short-circuits to a noop without staging", async () => {
    const projectRoot = await buildProjectRepo();
    const body = "payment refund ledger reconciliation nightly";
    const deps = await makeDeps(projectRoot, bagClient(), sequentialIds());
    await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"], source: "mcp" });
    const acceptedId = ulid(0);
    await stagingResolve(deps, acceptedId, "accept");

    const result = await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"], source: "mcp" });

    expect(result.outcome).toBe("noop");
    if (result.outcome === "noop") {
      expect(result.existingId).toBe(acceptedId);
    }
    expect(existsSync(join(deps.corpus.stagingDir, `${ulid(1)}.md`))).toBe(false);
    const noopDedup = eventsOfType(deps.corpus, "remember")
      .map((event) => event.dedup as {
        outcome: string;
        nearest_id: string | null;
        supersede_threshold: number;
        noop_threshold: number;
      })
      .find((dedup) => dedup.outcome === "noop")!;
    expect(noopDedup.nearest_id).toBe(acceptedId);
    expect(noopDedup.supersede_threshold).toBe(0.85);
    expect(noopDedup.noop_threshold).toBe(0.97);
  });

  test("body_len counts unicode code points, not UTF-16 code units, for an astral body", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const body = "release checklist 🎉 shipped";
    expect([...body].length).not.toBe(body.length);

    await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"], source: "mcp" });

    const remembered = eventsOfType(deps.corpus, "remember");
    expect(remembered[0]!.body_len).toBe([...body].length);
    expect(remembered[0]!.body_len).not.toBe(body.length);
  });

  test("a below-threshold neighbor records the real nearest_id and similarity on the remember event", async () => {
    const projectRoot = await buildProjectRepo();
    const storedBody = "connection pool sizing heuristics";
    const addedBody = "graphql resolver batch loading";
    const embeddings = keyedClient(new Map([[storedBody, [1, 0]], [addedBody, [3, 4]]]));
    const deps = await makeDeps(projectRoot, embeddings, sequentialIds());
    await remember(deps, { type: "pattern", body: storedBody, anchors: ["src/a.ts"], source: "mcp" });
    const storedId = ulid(0);
    await stagingResolve(deps, storedId, "accept");

    const result = await remember(deps, { type: "pattern", body: addedBody, anchors: ["src/a.ts"], source: "mcp" });

    expect(result.outcome).toBe("staged");
    if (result.outcome === "staged") {
      expect(result.dedup).toBe("add");
      expect(result.nearestId).toBeNull();
    }
    const added = eventsOfType(deps.corpus, "remember").find((event) => event.note_id === ulid(1))!;
    const dedup = added.dedup as { outcome: string; nearest_id: string | null; similarity: number | null };
    expect(dedup.outcome).toBe("add");
    expect(dedup.nearest_id).toBe(storedId);
    expect(dedup.similarity).toBeCloseTo(0.6, 5);
  });
});

describe("stagingResolve accept", () => {
  test("moves the note into notes, commits, rebuilds the index, and emits note_accepted", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "bugfix", body: "flaky retry bug fixed", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    const result = await stagingResolve(deps, id, "accept");

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(deps.corpus.notesDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.dedup.json`))).toBe(false);
    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("accept");
    expect(resolved[0]!.note_id).toBe(id);
    expect(resolved[0]!.staged_to_resolved_ms).toBe(0);
    expect(resolved[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    const indexedIds = (JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(indexedIds).toContain(id);
  });

  test("accept converges after a crash that moved the note before committing", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "bugfix", body: "resume path note", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);
    const staged = readFileSync(join(deps.corpus.stagingDir, `${id}.md`), "utf8");
    writeFileSync(join(deps.corpus.notesDir, `${id}.md`), staged);
    rmSync(join(deps.corpus.stagingDir, `${id}.md`));

    const first = await stagingResolve(deps, id, "accept");
    const second = await stagingResolve(deps, id, "accept");

    expect(first.outcome).toBe("accepted");
    expect(second).toEqual(first);
  });
});

describe("stagingResolve reject", () => {
  test("archives the note without committing and emits note_rejected", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "antipattern", body: "do not do this", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    const result = await stagingResolve(deps, id, "reject");

    expect(result.outcome).toBe("rejected");
    expect(existsSync(join(deps.corpus.archiveDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.notesDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.dedup.json`))).toBe(false);
    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("reject");
    expect(resolved[0]!.commit).toBeNull();
    expect(resolved[0]!.staged_to_resolved_ms).toBe(0);
    const head = await runGit(deps.corpus.corpusDir, ["rev-parse", "--verify", "HEAD"]);
    expect(head.exitCode).not.toBe(0);
  });

  test("reject replays idempotently without emitting a second staging_resolve event", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "antipattern", body: "reject twice", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    const first = await stagingResolve(deps, id, "reject");
    const second = await stagingResolve(deps, id, "reject");

    expect(first.outcome).toBe("rejected");
    expect(second).toEqual(first);
    expect(eventsOfType(deps.corpus, "staging_resolve").length).toBe(1);
  });
});

describe("gate-metrics menu and accepted measures (v14)", () => {
  const MENU = { decision_class: "curation" as const, options_n: 4, recommended_position: 2, chosen_position: 1 };

  test("accept stamps the menu and the accepted note's measures into the resolve event", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const body = "gate metrics accept 🎯 path";
    await remember(deps, { type: "bugfix", body, anchors: ["src/a.ts", "src/b.ts"], source: "mcp" });
    const id = ulid(0);

    await stagingResolve(deps, id, "accept", MENU);

    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.menu).toEqual(MENU);
    expect(resolved[0]!.accepted_body_len).toBe([...body].length);
    expect(resolved[0]!.accepted_anchors_n).toBe(2);
  });

  test("accept without a menu stamps menu null and staging behavior stays unchanged", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "bugfix", body: "no menu path", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    const result = await stagingResolve(deps, id, "accept");

    expect(result.outcome).toBe("accepted");
    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved[0]!.menu).toBeNull();
    expect(resolved[0]!.accepted_body_len).toBe([..."no menu path"].length);
  });

  test("reject carries null accepted measures and the menu it rode on", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "antipattern", body: "rejected with menu", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    await stagingResolve(deps, id, "reject", MENU);

    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved[0]!.accepted_body_len).toBeNull();
    expect(resolved[0]!.accepted_anchors_n).toBeNull();
    expect(resolved[0]!.menu).toEqual(MENU);
  });

  test("remember stamps a plan-fan menu on its event and null without one", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const fanMenu = { decision_class: "plan-fan" as const, options_n: 3, recommended_position: 2, chosen_position: 2 };

    await remember(deps, { type: "decision", body: "chose option B", anchors: ["src/a.ts"], source: "mcp", menu: fanMenu });
    await remember(deps, { type: "decision", body: "uninstrumented choice", anchors: ["src/a.ts"], source: "mcp" });

    const remembered = eventsOfType(deps.corpus, "remember");
    expect(remembered[0]!.menu).toEqual(fanMenu);
    expect(remembered[1]!.menu).toBeNull();
  });

  test("remember carries the note's tags verbatim on its event, and [] for a note without tags", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await remember(deps, { type: "decision", body: "run retro", anchors: [], tags: ["diary", "run:01ARZ3NDEKTSV4RRFFQ69G5FAV"], source: "mcp" });
    await remember(deps, { type: "decision", body: "anchored only", anchors: ["src/a.ts"], source: "mcp" });

    const remembered = eventsOfType(deps.corpus, "remember");
    expect(remembered[0]!.tags).toEqual(["diary", "run:01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(remembered[0]!.tags_n).toBe(2);
    expect(remembered[1]!.tags).toEqual([]);
    expect(remembered[1]!.tags_n).toBe(0);
  });
});

describe("stagingResolve supersede", () => {
  const targetBody = "original decision rationale";
  const newBody = "revised decision rationale";

  async function withSupersedeSetup(): Promise<{ deps: StagingDeps; targetId: string; newId: string; clock: MutableClock }> {
    const projectRoot = await buildProjectRepo();
    const embeddings = keyedClient(new Map([[targetBody, [1, 0]], [newBody, [75, 40]]]));
    const clock = mutableClock();
    const deps = await makeDeps(projectRoot, embeddings, sequentialIds(), clock.now);
    await remember(deps, { type: "decision", body: targetBody, anchors: ["src/a.ts"], source: "mcp" });
    const targetId = ulid(0);
    await stagingResolve(deps, targetId, "accept");
    await remember(deps, { type: "decision", body: newBody, anchors: ["src/a.ts"], source: "mcp" });
    return { deps, targetId, newId: ulid(1), clock };
  }

  test("commits the new note with supersedes set, drops the target on rebuild, emits one supersede event", async () => {
    const { deps, targetId, newId, clock } = await withSupersedeSetup();
    clock.advanceMilliseconds(3000);

    const result = await stagingResolve(deps, newId, { supersede: targetId });

    expect(result.outcome).toBe("superseded");
    if (result.outcome === "superseded") {
      expect(result.supersededId).toBe(targetId);
      expect(result.suggested).toBe(true);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    const note = parseNote(readFileSync(join(deps.corpus.notesDir, `${newId}.md`), "utf8"));
    expect(note.frontmatter.supersedes).toBe(targetId);
    expect(eventsOfType(deps.corpus, "remember").some((event) => event.note_id === newId)).toBe(true);
    const supersedeResolve = eventsOfType(deps.corpus, "staging_resolve").filter(
      (event) => event.decision === "supersede",
    );
    expect(supersedeResolve.length).toBe(1);
    expect(supersedeResolve[0]!.note_id).toBe(newId);
    expect(supersedeResolve[0]!.superseded_id).toBe(targetId);
    expect(supersedeResolve[0]!.suggested).toBe(true);
    expect(supersedeResolve[0]!.staged_to_resolved_ms).toBe(3000);
    expect(supersedeResolve[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    const indexedIds = (JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(indexedIds).toContain(newId);
    expect(indexedIds).not.toContain(targetId);
  });

  test("supersede replays idempotently to the same commit", async () => {
    const { deps, targetId, newId } = await withSupersedeSetup();

    const first = await stagingResolve(deps, newId, { supersede: targetId });
    const second = await stagingResolve(deps, newId, { supersede: targetId });

    expect(second.outcome).toBe("superseded");
    if (first.outcome === "superseded" && second.outcome === "superseded") {
      expect(second.commit).toBe(first.commit);
      expect(second.supersededId).toBe(first.supersededId);
    }
  });
});

describe("stagingResolve validation", () => {
  test("rejects a non-id resolve target", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await expect(stagingResolve(deps, "not-an-id", "accept")).rejects.toThrow(StagingError);
  });

  test("rejects resolving a staged note that does not exist", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await expect(stagingResolve(deps, ulid(9), "accept")).rejects.toThrow(StagingError);
  });

  test("supersede fails closed on an invalid target id without moving the staged note", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "a staged note", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    await expect(stagingResolve(deps, id, { supersede: "not-an-id" })).rejects.toThrow(StagingError);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(true);
  });

  test("supersede fails closed when the target is absent from notes", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "a staged note", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    await expect(stagingResolve(deps, id, { supersede: ulid(5) })).rejects.toThrow(StagingError);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.notesDir, `${id}.md`))).toBe(false);
  });

  test("supersede fails closed on self-supersession", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "a staged note", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);

    await expect(stagingResolve(deps, id, { supersede: id })).rejects.toThrow(StagingError);
  });
});

describe("stagingList", () => {
  test("lists staged notes with their whole body and dedup hints and emits staging_listed", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "first digest line\nrest of the body", anchors: ["src/a.ts"], source: "mcp" });
    await remember(deps, { type: "bugfix", body: "second note body", anchors: ["src/a.ts"], source: "mcp" });

    const entries = await stagingList(deps);

    expect(entries.length).toBe(2);
    const first = entries.find((entry) => entry.id === ulid(0))!;
    expect(first.body).toBe("first digest line\nrest of the body");
    expect(first.type).toBe("pattern");
    expect(first.dedup).toEqual({ kind: "unavailable" });
    const listed = eventsOfType(deps.corpus, "staging_listed");
    expect(listed.length).toBe(1);
    expect(listed[0]!.count).toBe(2);
  });

  test("returns an empty list for an empty staging area", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    expect(await stagingList(deps)).toEqual([]);
  });
});

describe("stagingList anchor liveness", () => {
  test("surfaces three-valued liveness for a note anchored to a tracked and a missing file", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "mixed anchors", anchors: ["src/a.ts", "src/gone.ts"], source: "mcp" });

    const entries = await stagingList(deps);

    expect(entries[0]!.anchors).toEqual([
      { path: "src/a.ts", liveness: "tracked" },
      { path: "src/gone.ts", liveness: "missing", everExisted: false },
    ]);
  });

  test("classifies an anchor present on disk but not git-tracked as untracked-exists, not missing", async () => {
    const projectRoot = await buildProjectRepo();
    writeFileSync(join(projectRoot, "src/fresh.ts"), "created this session\n");
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "fresh harvest", anchors: ["src/fresh.ts"], source: "mcp" });

    const entries = await stagingList(deps);

    expect(entries[0]!.anchors).toEqual([{ path: "src/fresh.ts", liveness: "untracked-exists" }]);
  });

  test("staging_listed carries per-entry anchor liveness telemetry", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "note one", anchors: ["src/a.ts", "src/gone.ts"], source: "mcp" });

    await stagingList(deps);

    const listed = eventsOfType(deps.corpus, "staging_listed");
    expect(listed[0]!.liveness).toEqual([
      {
        id: ulid(0),
        anchors: [
          { path: "src/a.ts", liveness: "tracked" },
          { path: "src/gone.ts", liveness: "missing", everExisted: false },
        ],
      },
    ]);
  });
});

describe("stagingList untracked-anchor warnings", () => {
  const WARNING_PREFIX = "warning: anchor";

  test("a gitignored anchor carries a warning naming the path, the ranking consequence and the cure", async () => {
    const projectRoot = await buildProjectRepo();
    writeFileSync(join(projectRoot, ".gitignore"), "dist/\n");
    mkdirSync(join(projectRoot, "dist"), { recursive: true });
    writeFileSync(join(projectRoot, "dist/out.js"), "built artifact\n");
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "anchored to a build artifact", anchors: ["dist/out.js"], source: "mcp" });

    const rendered = formatStagingList(await stagingList(deps), [], []);

    expect(rendered).toContain(
      "warning: anchor dist/out.js is not tracked by the project's git, so this note will sink in recall ranking; fix the anchor before accepting it",
    );
  });

  test("a deleted-from-history anchor keeps the classic sink warning", async () => {
    const projectRoot = await buildProjectRepo();
    await runGit(projectRoot, ["rm", "-q", "src/a.ts"]);
    await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "delete a"]);
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "anchored to a deleted file", anchors: ["src/a.ts"], source: "mcp" });

    const rendered = formatStagingList(await stagingList(deps), [], []);

    expect(rendered).toContain(`${WARNING_PREFIX} src/a.ts is not tracked`);
  });

  test("a concept anchor git never saw warns with the never-known wording", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "anchored to a concept", anchors: ["MultiSelect"], source: "mcp" });

    const rendered = formatStagingList(await stagingList(deps), [], []);

    expect(rendered).toContain(
      "warning: anchor MultiSelect was never known to the project's git — likely a concept, not a " +
        "file path; move it to tags or the note will sink in recall ranking",
    );
  });

  test("an anchor parked on another branch warns with the branch name and the moderate penalty", async () => {
    const projectRoot = await buildProjectRepo();
    await runGit(projectRoot, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(projectRoot, "src/parked.ts"), "parked content\n");
    await runGit(projectRoot, ["add", "-A"]);
    await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "park"]);
    await runGit(projectRoot, ["checkout", "-q", "main"]);
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "anchored to a parked file", anchors: ["src/parked.ts"], source: "mcp" });

    const rendered = formatStagingList(await stagingList(deps), [], []);

    expect(rendered).toContain(
      "warning: anchor src/parked.ts lives on branch feature, not here; the note takes a moderate ranking penalty until the merge",
    );
  });

  test("a note whose anchors are all tracked renders without warning noise", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "anchored to committed code", anchors: ["src/a.ts"], source: "mcp" });

    const rendered = formatStagingList(await stagingList(deps), [], []);

    expect(rendered).not.toContain(WARNING_PREFIX);
  });

  test("accepting a warned note is not blocked and commits exactly as before", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "accepted despite the warning", anchors: ["src/gone.ts"], source: "mcp" });

    const result = await stagingResolve(deps, ulid(0), "accept");

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("remember with tags", () => {
  test("a tags-only note stages legally and renders its tags with the pathless notice", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const result = await remember(deps, {
      type: "decision",
      body: "soft-delete keeps memberships at zero",
      anchors: [],
      tags: ["soft-delete", "Tickets::FindSimilarGroup"],
      source: "mcp",
    });

    expect(result.outcome).toBe("staged");
    const rendered = formatStagingList(await stagingList(deps), [], []);
    expect(rendered).toContain("anchors: (none)");
    expect(rendered).toContain("tags: soft-delete, Tickets::FindSimilarGroup");
    expect(rendered).toContain(
      "note: no path anchors — this note takes no part in anchorOverlap or staleness ranking; " +
        "normal for a conceptual note, add a tracked file path to give it a code address",
    );
  });

  test("tags ride alongside anchors and the pathless notice stays silent", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, {
      type: "decision",
      body: "anchored and tagged",
      anchors: ["src/a.ts"],
      tags: ["lock ordering"],
      source: "mcp",
    });

    const rendered = formatStagingList(await stagingList(deps), [], []);
    expect(rendered).toContain("tags: lock ordering");
    expect(rendered).not.toContain("note: no path anchors");
  });

  test("empty anchors with no tags fail closed before anything is staged", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await expect(
      remember(deps, { type: "decision", body: "addressless note", anchors: [], source: "mcp" }),
    ).rejects.toThrow(NoteValidationError);
    expect(readdirSync(join(deps.corpus.stagingDir))).toEqual([]);
  });

  test("an empty tags array normalizes to key absence and stays rejected when anchors are empty too", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await expect(
      remember(deps, { type: "decision", body: "addressless note", anchors: [], tags: [], source: "mcp" }),
    ).rejects.toThrow(NoteValidationError);
  });

  test("a tags-only note accepts through the human gate and keeps its tags in notes/", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, {
      type: "decision",
      body: "concept note accepted",
      anchors: [],
      tags: ["invariant"],
      source: "mcp",
    });

    const result = await stagingResolve(deps, ulid(0), "accept");

    expect(result.outcome).toBe("accepted");
    const stored = parseNote(readFileSync(join(deps.corpus.notesDir, `${ulid(0)}.md`), "utf8"));
    expect(stored.frontmatter.tags).toEqual(["invariant"]);
    expect(stored.frontmatter.anchors).toEqual([]);
  });
});

describe("stagingList dedup honesty", () => {
  const targetBody = "original decision rationale";
  const newBody = "revised decision rationale";

  test("reports dedup unavailable for a degraded sidecar rather than claiming no neighbor", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "degraded dedup", anchors: ["src/a.ts"], source: "mcp" });

    const entries = await stagingList(deps);

    expect(entries[0]!.dedup).toEqual({ kind: "unavailable" });
  });

  test("reports dedup unavailable without crashing when the sidecar is absent", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "no sidecar note", anchors: ["src/a.ts"], source: "mcp" });
    rmSync(join(deps.corpus.stagingDir, `${ulid(0)}.dedup.json`));

    const entries = await stagingList(deps);

    expect(entries[0]!.dedup).toEqual({ kind: "unavailable" });
  });

  test("reports no close neighbor when dedup ran and found nothing near", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, bagClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "lonely note about widgets", anchors: ["src/a.ts"], source: "mcp" });

    const entries = await stagingList(deps);

    expect(entries[0]!.dedup).toEqual({ kind: "no_neighbor", judge: null });
  });

  test("surfaces the nearest neighbor when dedup offers a supersede", async () => {
    const projectRoot = await buildProjectRepo();
    const embeddings = keyedClient(new Map([[targetBody, [1, 0]], [newBody, [75, 40]]]));
    const deps = await makeDeps(projectRoot, embeddings, sequentialIds());
    await remember(deps, { type: "decision", body: targetBody, anchors: ["src/a.ts"], source: "mcp" });
    const targetId = ulid(0);
    await stagingResolve(deps, targetId, "accept");
    await remember(deps, { type: "decision", body: newBody, anchors: ["src/a.ts"], source: "mcp" });

    const entries = await stagingList(deps);

    const staged = entries.find((entry) => entry.id === ulid(1))!;
    expect(staged.dedup.kind).toBe("neighbor");
    if (staged.dedup.kind === "neighbor") {
      expect(staged.dedup.nearestId).toBe(targetId);
      expect(staged.dedup.similarity).toBeGreaterThan(0.85);
      expect(staged.dedup.similarity).toBeLessThan(0.97);
    }
  });
});

describe("staged_to_resolved_ms", () => {
  test("records the elapsed time between a v2 remember and its resolution", async () => {
    const projectRoot = await buildProjectRepo();
    const clock = mutableClock();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds(), clock.now);
    await remember(deps, { type: "bugfix", body: "elapsed measurement note", anchors: ["src/a.ts"], source: "mcp" });
    const id = ulid(0);
    clock.advanceMilliseconds(5000);

    await stagingResolve(deps, id, "accept");

    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved[0]!.staged_to_resolved_ms).toBe(5000);
  });

  test("attributes the elapsed time to the resolved note, not an earlier-staged sibling", async () => {
    const projectRoot = await buildProjectRepo();
    const clock = mutableClock();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds(), clock.now);
    await remember(deps, { type: "bugfix", body: "earlier sibling note", anchors: ["src/a.ts"], source: "mcp" });
    clock.advanceMilliseconds(4000);
    await remember(deps, { type: "bugfix", body: "later resolved note", anchors: ["src/a.ts"], source: "mcp" });
    clock.advanceMilliseconds(2000);

    await stagingResolve(deps, ulid(1), "accept");

    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved[0]!.note_id).toBe(ulid(1));
    expect(resolved[0]!.staged_to_resolved_ms).toBe(2000);
  });

  test("computes the elapsed time from a legacy note_staged anchor when there is no v2 remember event", async () => {
    const projectRoot = await buildProjectRepo();
    const clock = mutableClock();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds(), clock.now);
    const id = ulid(0);
    appendLegacyNoteStaged(deps, id, CLOCK_START);
    stageNoteFileWithoutEvent(deps, id, "legacy staged body");
    clock.advanceMilliseconds(9000);

    await stagingResolve(deps, id, "accept");

    expect(eventsOfType(deps.corpus, "remember")).toEqual([]);
    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved[0]!.staged_to_resolved_ms).toBe(9000);
  });

  test("records null elapsed time when the note has no staging event in the log", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const id = ulid(0);
    stageNoteFileWithoutEvent(deps, id, "orphaned staged body");

    await stagingResolve(deps, id, "accept");

    const resolved = eventsOfType(deps.corpus, "staging_resolve");
    expect(resolved[0]!.staged_to_resolved_ms).toBeNull();
  });
});

// The rebuild runs after the decision is committed and logged. A rebuild that throws there must leave
// a committed outcome that says so — never a bare error that invites a retry of a decision that went
// through. index.db replaced by a directory fails the rebuild for real, at open (not the NOTADB case,
// which the rebuild heals), and removing the directory repairs it.
const UNOPENABLE_INDEX_REASON = "unable to open database file";

interface IndexRow {
  id: string;
  staleness_boost: number;
}

interface DecisionScenario {
  name: string;
  // Prepares a corpus with a healthy index and returns the id the decision resolves.
  stage: (deps: StagingDeps) => Promise<string>;
  decision: ResolveDecision;
  outcome: ResolveResult["outcome"];
  decisionEvent: string;
  rejectedOutcome: ResolveResult["outcome"] | null;
  reflectedIn: (rows: IndexRow[]) => void;
}

async function acceptedNote(deps: StagingDeps, body: string, anchors: string[]): Promise<string> {
  const staged = await remember(deps, { type: "decision", body, anchors, source: "mcp" });
  if (staged.outcome !== "staged") throw new Error(`expected a staged note, got ${staged.outcome}`);
  await stagingResolve(deps, staged.noteId, "accept");
  return staged.noteId;
}

function breakIndex(corpus: Corpus): void {
  for (const path of [corpus.indexPath, `${corpus.indexPath}-wal`, `${corpus.indexPath}-shm`]) {
    rmSync(path, { force: true });
  }
  mkdirSync(corpus.indexPath);
}

function indexRows(corpus: Corpus): IndexRow[] {
  return JSON.parse(dumpIndex(corpus.indexPath)) as IndexRow[];
}

function rowOf(rows: IndexRow[], id: string): IndexRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`note ${id} is not in the index`);
  return row;
}

const DECISION_SCENARIOS: DecisionScenario[] = [
  {
    name: "accept",
    stage: async (deps) => {
      await remember(deps, { type: "bugfix", body: "flaky retry bug fixed", anchors: ["src/a.ts"], source: "mcp" });
      return ulid(0);
    },
    decision: "accept",
    outcome: "accepted",
    decisionEvent: "staging_resolve",
    rejectedOutcome: "rejected",
    reflectedIn: (rows) => expect(rows.map((row) => row.id)).toContain(ulid(0)),
  },
  {
    name: "supersede",
    stage: async (deps) => {
      await acceptedNote(deps, "original decision rationale", ["src/a.ts"]);
      await remember(deps, { type: "decision", body: "revised decision rationale", anchors: ["src/a.ts"], source: "mcp" });
      return ulid(1);
    },
    decision: { supersede: ulid(0) },
    outcome: "superseded",
    decisionEvent: "staging_resolve",
    rejectedOutcome: null,
    reflectedIn: (rows) => {
      expect(rows.map((row) => row.id)).toContain(ulid(1));
      expect(rows.map((row) => row.id)).not.toContain(ulid(0));
    },
  },
  {
    name: "retire request accept",
    stage: async (deps) => {
      const noteId = await acceptedNote(deps, "a decision that went stale", ["src/a.ts"]);
      return noteRetire(deps, noteId, "the module it describes was removed").requestId;
    },
    decision: "accept",
    outcome: "retired",
    decisionEvent: "note_retire_resolved",
    rejectedOutcome: "retire_rejected",
    reflectedIn: (rows) => expect(rows.map((row) => row.id)).not.toContain(ulid(0)),
  },
  {
    name: "re-anchor request accept",
    stage: async (deps) => {
      const noteId = await acceptedNote(deps, "a decision whose file moved", ["src/old.ts"]);
      return (await noteReanchor(deps, noteId, "src/old.ts", "src/a.ts", null, "manual")).requestId;
    },
    decision: "accept",
    outcome: "reanchored",
    decisionEvent: "note_reanchor_resolved",
    rejectedOutcome: "reanchor_rejected",
    reflectedIn: (rows) => expect(rowOf(rows, ulid(0)).staleness_boost).toBe(0),
  },
  {
    name: "retag request accept",
    stage: async (deps) => {
      const noteId = await acceptedNote(deps, "a decision about multi select", ["src/a.ts", "MultiSelect"]);
      return (await noteRetag(deps, noteId, "MultiSelect")).requestId;
    },
    decision: "accept",
    outcome: "retagged",
    decisionEvent: "note_retag_resolved",
    rejectedOutcome: "retag_rejected",
    reflectedIn: (rows) => expect(rowOf(rows, ulid(0)).staleness_boost).toBe(0),
  },
];

describe("stagingResolve when the rebuild fails after the commit", () => {
  for (const scenario of DECISION_SCENARIOS) {
    test(`${scenario.name}: the committed outcome carries the reason, rebuild_failed follows the decision, the index catches up`, async () => {
      const projectRoot = await buildProjectRepo();
      const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
      const id = await scenario.stage(deps);
      breakIndex(deps.corpus);

      const result = await stagingResolve(deps, id, scenario.decision);

      expect(result.outcome).toBe(scenario.outcome);
      if (!("index" in result) || result.index.rebuilt) {
        throw new Error(`expected a committed outcome whose index was not rebuilt, got ${JSON.stringify(result)}`);
      }
      expect(result.index.reason).toBe(UNOPENABLE_INDEX_REASON);
      const head = await runGit(deps.corpus.corpusDir, ["rev-parse", "HEAD"]);
      expect(head.stdout.trim()).toBe(result.commit);
      const events = readEvents(deps.corpus.eventsDir);
      expect(events.slice(-2).map((event) => event.type)).toEqual([scenario.decisionEvent, "rebuild_failed"]);
      const failure = events.at(-1)!;
      expect(failure.message).toBe(result.index.reason);
      expect(String(failure.message)).not.toContain(deps.corpus.corpusDir);

      rmSync(deps.corpus.indexPath, { recursive: true });
      await rebuild(rebuildDeps(deps));
      scenario.reflectedIn(indexRows(deps.corpus));
    });

    test(`${scenario.name}: a healthy rebuild reports the index rebuilt and logs no rebuild_failed`, async () => {
      const projectRoot = await buildProjectRepo();
      const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
      const id = await scenario.stage(deps);

      const result = await stagingResolve(deps, id, scenario.decision);

      expect(result.outcome).toBe(scenario.outcome);
      expect("index" in result && result.index).toEqual({ rebuilt: true });
      expect(eventsOfType(deps.corpus, "rebuild_failed")).toEqual([]);
      scenario.reflectedIn(indexRows(deps.corpus));
    });
  }

  for (const scenario of DECISION_SCENARIOS.filter((candidate) => candidate.rejectedOutcome !== null)) {
    test(`${scenario.name}: the reject outcome runs no rebuild and carries no index`, async () => {
      const projectRoot = await buildProjectRepo();
      const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
      const id = await scenario.stage(deps);
      breakIndex(deps.corpus);

      const result = await stagingResolve(deps, id, "reject");

      expect(result.outcome).toBe(scenario.rejectedOutcome!);
      expect(Object.keys(result)).not.toContain("index");
      expect(eventsOfType(deps.corpus, "rebuild_failed")).toEqual([]);
    });
  }
});

describe("commit identity capture on the accepting writes", () => {
  async function corpusHeadPaths(deps: StagingDeps): Promise<string[]> {
    const shown = await runGit(deps.corpus.corpusDir, ["show", "--name-only", "--format=", "HEAD"]);
    return shown.stdout.split("\n").filter((line) => line !== "").sort();
  }

  async function projectHead(projectRoot: string): Promise<string> {
    return (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async function advanceProject(projectRoot: string, content: string): Promise<string> {
    writeFileSync(join(projectRoot, "src/a.ts"), `${content}\n`);
    await runGit(projectRoot, ["add", "src/a.ts"]);
    const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", content]);
    if (committed.exitCode !== 0) throw new Error(committed.stderr);
    return projectHead(projectRoot);
  }

  // An accepted note from before the store existed: in notes/ and committed, with no identity.
  async function seedLegacyNote(deps: StagingDeps, n: number, commit: string): Promise<void> {
    const id = ulid(100 + n);
    writeFileSync(
      join(deps.corpus.notesDir, `${id}.md`),
      serializeNote({
        frontmatter: { id, type: "decision", anchors: ["src/a.ts"], commit, created: CLOCK_START },
        body: `legacy decision number ${n}`,
      }),
    );
    await runGit(deps.corpus.corpusDir, ["add", `notes/${id}.md`]);
    await runGit(deps.corpus.corpusDir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "legacy"]);
  }

  function storedCommits(deps: StagingDeps): string[] {
    return readdirSync(deps.corpus.commitIdentitiesDir).sort();
  }

  test("accept writes the identity of the note's commit into the same corpus commit as the note", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "decision", body: "ledger split decision", anchors: ["src/a.ts"], source: "mcp" });
    const head = await projectHead(projectRoot);

    await stagingResolve(deps, ulid(0), "accept");

    expect(await corpusHeadPaths(deps)).toEqual([`commit-identities/${head}`, `notes/${ulid(0)}.md`]);
  });

  test("the first accept after the upgrade records every live commit the corpus pins", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    const first = await projectHead(projectRoot);
    const second = await advanceProject(projectRoot, "second");
    await seedLegacyNote(deps, 1, first);
    await seedLegacyNote(deps, 2, second);
    await seedLegacyNote(deps, 3, second);
    const third = await advanceProject(projectRoot, "third");
    await remember(deps, { type: "decision", body: "fourth decision after upgrade", anchors: ["src/a.ts"], source: "mcp" });

    await stagingResolve(deps, ulid(0), "accept");

    expect(storedCommits(deps)).toEqual([first, second, third].sort());
    expect(await corpusHeadPaths(deps)).toEqual(
      [...[first, second, third].map((commit) => `commit-identities/${commit}`), `notes/${ulid(0)}.md`].sort(),
    );
  });

  test("a note on a gone object does not block the accept and gets no identity", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await seedLegacyNote(deps, 1, "deadbeef".repeat(5));
    await remember(deps, { type: "decision", body: "decision beside a gone commit", anchors: ["src/a.ts"], source: "mcp" });

    const result = await stagingResolve(deps, ulid(0), "accept");

    expect(result.outcome).toBe("accepted");
    expect(storedCommits(deps)).toEqual([await projectHead(projectRoot)]);
  });

  test("a second accept on the same project HEAD commits no identity path", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "decision", body: "first decision same head", anchors: ["src/a.ts"], source: "mcp" });
    await remember(deps, { type: "bugfix", body: "second fix same head", anchors: ["src/a.ts"], source: "mcp" });
    await stagingResolve(deps, ulid(0), "accept");
    const storedAfterFirst = readFileSync(join(deps.corpus.commitIdentitiesDir, await projectHead(projectRoot)), "utf8");

    await stagingResolve(deps, ulid(1), "accept");

    expect(await corpusHeadPaths(deps)).toEqual([`notes/${ulid(1)}.md`]);
    expect(readFileSync(join(deps.corpus.commitIdentitiesDir, await projectHead(projectRoot)), "utf8")).toBe(storedAfterFirst);
  });

  test("the identity of an accept whose commit failed reaches history with its retry", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "decision", body: "decision interrupted by a lock", anchors: ["src/a.ts"], source: "mcp" });
    const head = await projectHead(projectRoot);
    const lockPath = join(deps.corpus.corpusDir, ".git", "index.lock");
    writeFileSync(lockPath, "");

    await expect(stagingResolve(deps, ulid(0), "accept")).rejects.toThrow(CorpusBusyError);
    expect(storedCommits(deps)).toEqual([head]);
    rmSync(lockPath);
    const retried = await stagingResolve(deps, ulid(0), "accept");

    expect(retried.outcome).toBe("accepted");
    expect(await corpusHeadPaths(deps)).toEqual([`commit-identities/${head}`, `notes/${ulid(0)}.md`]);
    const status = await runGit(deps.corpus.corpusDir, ["status", "--porcelain"], ["commit-identities", "notes"]);
    expect(status.stdout).toBe("");
  });

  test("a git failure refuses the accept before anything is written", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "decision", body: "decision of a vanished repository", anchors: ["src/a.ts"], source: "mcp" });
    const vanished = { ...deps, projectRoot: mkdtempSync(join(tmpdir(), "mneme-staging-not-a-repo-")) };

    await expect(stagingResolve(vanished, ulid(0), "accept")).rejects.toThrow(CommitIdentityReadError);
    expect(existsSync(join(deps.corpus.stagingDir, `${ulid(0)}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.notesDir, `${ulid(0)}.md`))).toBe(false);
    expect(storedCommits(deps)).toEqual([]);
  });

  test("supersede writes the identity of the new note's commit into its corpus commit", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "decision", body: "the old ledger decision", anchors: ["src/a.ts"], source: "mcp" });
    await stagingResolve(deps, ulid(0), "accept");
    const moved = await advanceProject(projectRoot, "moved");
    await remember(deps, { type: "decision", body: "the new ledger decision", anchors: ["src/a.ts"], source: "mcp" });

    await stagingResolve(deps, ulid(1), { supersede: ulid(0) });

    expect(await corpusHeadPaths(deps)).toEqual([`commit-identities/${moved}`, `notes/${ulid(1)}.md`]);
  });
});

describe("remember with a judge", () => {
  const storedBody = "connection pool sizing heuristics";
  const addedBody = "graphql resolver batch loading";
  const JUDGE_MODEL_UNDER_TEST = "jev-test";
  const SUPERSEDES = { duplicate: 0, supersedes: 0.9, contradicts: 0.05, complements: 0.05, unrelated: 0 };

  interface JudgeLog {
    count: number;
  }

  // The real HttpJudgeClient over a fetch at the network boundary: `answering` plays a System One
  // that reads every pair as a supersede; `failing` plays an outage.
  function answering(log: JudgeLog): FetchImplementation {
    return async () => {
      log.count++;
      return {
        ok: true,
        json: async () => ({ answers: { relation: { type: "choice", choice: "supersedes", probabilities: SUPERSEDES, confidence: 0.88 } } }),
      };
    };
  }

  function failing(log: JudgeLog): FetchImplementation {
    return async () => {
      log.count++;
      throw new TypeError("connection refused");
    };
  }

  function judgeOver(fetchImplementation: FetchImplementation): JudgeClient {
    return new HttpJudgeClient("https://judge.test", fetchImplementation, JUDGE_MODEL_UNDER_TEST, "apikey-test");
  }

  // One accepted note and a second, far one (cosine 0.6, an `add` below the offer threshold):
  // exactly the pair where the cosine hint says "no close neighbor" and the judge still has a view.
  async function depsWithAcceptedNeighbor(judge: JudgeClient | undefined): Promise<{ deps: StagingDeps; storedId: string }> {
    const projectRoot = await buildProjectRepo();
    const embeddings = keyedClient(new Map([[storedBody, [1, 0]], [addedBody, [3, 4]]]));
    const deps = await makeDeps(projectRoot, embeddings, sequentialIds(), fixedClock, judge);
    await remember(deps, { type: "decision", body: storedBody, anchors: ["src/a.ts"], source: "mcp" });
    const storedId = ulid(0);
    await stagingResolve(deps, storedId, "accept");
    return { deps, storedId };
  }

  test("a configured judge writes its verdict into the result, the sidecar and the remember event", async () => {
    const log: JudgeLog = { count: 0 };
    const { deps, storedId } = await depsWithAcceptedNeighbor(judgeOver(answering(log)));

    const result = await remember(deps, { type: "decision", body: addedBody, anchors: ["src/a.ts"], tags: ["graphql"], source: "mcp" });

    expect(log.count).toBe(1);
    expect(result.outcome).toBe("staged");
    if (result.outcome === "staged") {
      expect(result.dedup).toBe("add");
      expect(result.nearestId).toBeNull();
      expect(result.judge).toEqual({
        degraded: false,
        model: JUDGE_MODEL_UNDER_TEST,
        neighborId: storedId,
        relation: "supersedes",
        probabilities: SUPERSEDES,
        confidence: 0.88,
        recommended: true,
      });
    }
    const sidecar = JSON.parse(readFileSync(join(deps.corpus.stagingDir, `${ulid(1)}.dedup.json`), "utf8")) as { judge: { recommended: boolean; neighborId: string } };
    expect(sidecar.judge.recommended).toBe(true);
    expect(sidecar.judge.neighborId).toBe(storedId);
    const event = eventsOfType(deps.corpus, "remember").find((candidate) => candidate.note_id === ulid(1))!;
    const dedup = event.dedup as { nearest_id: string; judge: unknown };
    expect(dedup.nearest_id).toBe(storedId);
    expect(dedup.judge).toEqual({
      model: JUDGE_MODEL_UNDER_TEST,
      relation: "supersedes",
      probabilities: SUPERSEDES,
      confidence: 0.88,
      recommended: true,
      degraded: false,
    });
    const entries = await stagingList(deps);
    expect(entries.find((entry) => entry.id === ulid(1))!.dedup).toEqual({
      kind: "no_neighbor",
      judge: { degraded: false, model: JUDGE_MODEL_UNDER_TEST, neighborId: storedId, relation: "supersedes", probabilities: SUPERSEDES, confidence: 0.88, recommended: true },
    });
  });

  test("without a judge the verdict is null everywhere and the staging surface is the historical one", async () => {
    const { deps, storedId } = await depsWithAcceptedNeighbor(undefined);

    const result = await remember(deps, { type: "decision", body: addedBody, anchors: ["src/a.ts"], source: "mcp" });

    if (result.outcome === "staged") {
      expect(result.judge).toBeNull();
    }
    const sidecar = JSON.parse(readFileSync(join(deps.corpus.stagingDir, `${ulid(1)}.dedup.json`), "utf8")) as { judge: unknown; nearest_id: unknown };
    expect(sidecar.judge).toBeNull();
    expect(sidecar.nearest_id).toBeNull();
    const event = eventsOfType(deps.corpus, "remember").find((candidate) => candidate.note_id === ulid(1))!;
    const dedup = event.dedup as { nearest_id: string; judge: unknown };
    expect(dedup.nearest_id).toBe(storedId);
    expect(dedup.judge).toBeNull();
    const entries = await stagingList(deps);
    expect(entries.find((entry) => entry.id === ulid(1))!.dedup).toEqual({ kind: "no_neighbor", judge: null });
    expect(formatStagingList(entries, [], [])).not.toContain("judge");
  });

  test("a noop never asks the judge", async () => {
    const log: JudgeLog = { count: 0 };
    const projectRoot = await buildProjectRepo();
    const body = "payment refund ledger reconciliation nightly";
    const deps = await makeDeps(projectRoot, bagClient(), sequentialIds(), fixedClock, judgeOver(answering(log)));
    await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"], source: "mcp" });
    await stagingResolve(deps, ulid(0), "accept");

    const result = await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"], source: "mcp" });

    expect(result.outcome).toBe("noop");
    expect(log.count).toBe(0);
    const noop = eventsOfType(deps.corpus, "remember").find((event) => (event.dedup as { outcome: string }).outcome === "noop")!;
    expect((noop.dedup as { judge: unknown }).judge).toBeNull();
  });

  test("a judge outage degrades the verdict and the note is staged all the same", async () => {
    const log: JudgeLog = { count: 0 };
    const { deps, storedId } = await depsWithAcceptedNeighbor(judgeOver(failing(log)));

    const result = await remember(deps, { type: "decision", body: addedBody, anchors: ["src/a.ts"], source: "mcp" });

    expect(log.count).toBe(1);
    expect(result.outcome).toBe("staged");
    if (result.outcome === "staged") {
      expect(result.judge).toEqual({ degraded: true, model: JUDGE_MODEL_UNDER_TEST, neighborId: storedId });
    }
    expect(existsSync(join(deps.corpus.stagingDir, `${ulid(1)}.md`))).toBe(true);
    const event = eventsOfType(deps.corpus, "remember").find((candidate) => candidate.note_id === ulid(1))!;
    expect((event.dedup as { judge: unknown }).judge).toEqual({
      model: JUDGE_MODEL_UNDER_TEST,
      relation: null,
      probabilities: null,
      confidence: null,
      recommended: null,
      degraded: true,
    });
  });
});
