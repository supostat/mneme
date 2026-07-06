import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, initRepo } from "./git";
import { resolveCorpus } from "./corpus";
import type { Corpus } from "./corpus";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { parseNote } from "./note";
import type { EmbeddingsClient } from "./embeddings";
import { EMBEDDING_DIMENSION } from "./embeddings";
import { dumpIndex } from "./index-db";
import { remember, stagingList, stagingResolve, StagingError } from "./staging";
import type { StagingDeps } from "./staging";

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
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [] }
        : { available: false, embeddings: [] },
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
    embed: async (inputs) => {
      if (inputs.length === 0) return { available: true, embeddings: [] };
      return {
        available: true,
        embeddings: inputs.map((body) => {
          const components = byBody.get(body);
          if (components === undefined) throw new Error(`no vector for body: ${body}`);
          return vectorFrom(components);
        }),
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
    embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector) }),
  };
}

async function makeDeps(
  projectRoot: string,
  embeddings: EmbeddingsClient,
  idFactory: () => string,
): Promise<StagingDeps> {
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-staging-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, {
    sessionId: "s-staging",
    mnemeVersion: "0.1.0",
    clock: fixedClock,
  });
  return { corpus, projectRoot, clock: fixedClock, idFactory, embeddings, eventWriter };
}

function eventsOfType(corpus: Corpus, type: string): StoredEvent[] {
  return readEvents(corpus.eventsDir).filter((event) => event.type === type);
}

describe("remember staging", () => {
  test("stages an ADD note with a degraded sidecar and emits note_staged", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    const result = await remember(deps, { type: "pattern", body: "graceful shutdown sequence", anchors: ["src/a.ts"] });

    expect(result.outcome).toBe("staged");
    if (result.outcome === "staged") {
      expect(result.dedup).toBe("add");
      expect(result.degraded).toBe(true);
      expect(result.nearestId).toBeNull();
    }
    const id = ulid(0);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.dedup.json`))).toBe(true);
    const staged = eventsOfType(deps.corpus, "note_staged");
    expect(staged.length).toBe(1);
    expect(staged[0]!.note_id).toBe(id);
    expect(staged[0]!.note_type).toBe("pattern");
  });

  test("throws when the project has no resolvable HEAD", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mneme-staging-nohead-"));
    await initRepo(projectRoot);
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());

    await expect(
      remember(deps, { type: "pattern", body: "b", anchors: ["src/a.ts"] }),
    ).rejects.toThrow(StagingError);
  });

  test("a bad idFactory throws before anything is written to staging", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), () => "not-a-valid-id");

    await expect(
      remember(deps, { type: "pattern", body: "body that must never be staged", anchors: ["src/a.ts"] }),
    ).rejects.toThrow(StagingError);
    expect(readdirSync(deps.corpus.stagingDir)).toEqual([]);
  });

  test("a near-identical body short-circuits to a noop without staging", async () => {
    const projectRoot = await buildProjectRepo();
    const body = "payment refund ledger reconciliation nightly";
    const deps = await makeDeps(projectRoot, bagClient(), sequentialIds());
    await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"] });
    const acceptedId = ulid(0);
    await stagingResolve(deps, acceptedId, "accept");

    const result = await remember(deps, { type: "pattern", body, anchors: ["src/a.ts"] });

    expect(result.outcome).toBe("noop");
    if (result.outcome === "noop") {
      expect(result.existingId).toBe(acceptedId);
    }
    expect(existsSync(join(deps.corpus.stagingDir, `${ulid(1)}.md`))).toBe(false);
    const deduped = eventsOfType(deps.corpus, "note_deduped");
    expect(deduped.length).toBe(1);
    expect(deduped[0]!.existing_id).toBe(acceptedId);
    expect(deduped[0]!.supersede_threshold).toBe(0.85);
    expect(deduped[0]!.noop_threshold).toBe(0.97);
  });
});

describe("stagingResolve accept", () => {
  test("moves the note into notes, commits, rebuilds the index, and emits note_accepted", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "bugfix", body: "flaky retry bug fixed", anchors: ["src/a.ts"] });
    const id = ulid(0);

    const result = await stagingResolve(deps, id, "accept");

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(deps.corpus.notesDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.dedup.json`))).toBe(false);
    expect(eventsOfType(deps.corpus, "note_accepted").length).toBe(1);
    const indexedIds = (JSON.parse(dumpIndex(deps.corpus.indexPath)) as Array<{ id: string }>).map((row) => row.id);
    expect(indexedIds).toContain(id);
  });

  test("accept converges after a crash that moved the note before committing", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "bugfix", body: "resume path note", anchors: ["src/a.ts"] });
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
    await remember(deps, { type: "antipattern", body: "do not do this", anchors: ["src/a.ts"] });
    const id = ulid(0);

    const result = await stagingResolve(deps, id, "reject");

    expect(result.outcome).toBe("rejected");
    expect(existsSync(join(deps.corpus.archiveDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.notesDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(false);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.dedup.json`))).toBe(false);
    expect(eventsOfType(deps.corpus, "note_rejected").length).toBe(1);
    expect(eventsOfType(deps.corpus, "note_accepted").length).toBe(0);
    const head = await runGit(deps.corpus.corpusDir, ["rev-parse", "--verify", "HEAD"]);
    expect(head.exitCode).not.toBe(0);
  });
});

describe("stagingResolve supersede", () => {
  const targetBody = "original decision rationale";
  const newBody = "revised decision rationale";

  async function withSupersedeSetup(): Promise<{ deps: StagingDeps; targetId: string; newId: string }> {
    const projectRoot = await buildProjectRepo();
    const embeddings = keyedClient(new Map([[targetBody, [1, 0]], [newBody, [75, 40]]]));
    const deps = await makeDeps(projectRoot, embeddings, sequentialIds());
    await remember(deps, { type: "decision", body: targetBody, anchors: ["src/a.ts"] });
    const targetId = ulid(0);
    await stagingResolve(deps, targetId, "accept");
    await remember(deps, { type: "decision", body: newBody, anchors: ["src/a.ts"] });
    return { deps, targetId, newId: ulid(1) };
  }

  test("commits the new note with supersedes set, drops the target on rebuild, emits both events", async () => {
    const { deps, targetId, newId } = await withSupersedeSetup();

    const result = await stagingResolve(deps, newId, { supersede: targetId });

    expect(result.outcome).toBe("superseded");
    if (result.outcome === "superseded") {
      expect(result.supersededId).toBe(targetId);
      expect(result.suggested).toBe(true);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    const note = parseNote(readFileSync(join(deps.corpus.notesDir, `${newId}.md`), "utf8"));
    expect(note.frontmatter.supersedes).toBe(targetId);
    expect(eventsOfType(deps.corpus, "note_accepted").some((event) => event.note_id === newId)).toBe(true);
    expect(eventsOfType(deps.corpus, "note_staged").some((event) => event.note_id === newId)).toBe(true);
    const superseded = eventsOfType(deps.corpus, "note_superseded");
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.note_id).toBe(newId);
    expect(superseded[0]!.superseded_id).toBe(targetId);
    expect(superseded[0]!.suggested).toBe(true);
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
    await remember(deps, { type: "pattern", body: "a staged note", anchors: ["src/a.ts"] });
    const id = ulid(0);

    await expect(stagingResolve(deps, id, { supersede: "not-an-id" })).rejects.toThrow(StagingError);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(true);
  });

  test("supersede fails closed when the target is absent from notes", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "a staged note", anchors: ["src/a.ts"] });
    const id = ulid(0);

    await expect(stagingResolve(deps, id, { supersede: ulid(5) })).rejects.toThrow(StagingError);
    expect(existsSync(join(deps.corpus.stagingDir, `${id}.md`))).toBe(true);
    expect(existsSync(join(deps.corpus.notesDir, `${id}.md`))).toBe(false);
  });

  test("supersede fails closed on self-supersession", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "a staged note", anchors: ["src/a.ts"] });
    const id = ulid(0);

    await expect(stagingResolve(deps, id, { supersede: id })).rejects.toThrow(StagingError);
  });
});

describe("stagingList", () => {
  test("lists staged notes with a body digest and dedup hints and emits staging_listed", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "first digest line\nrest of the body", anchors: ["src/a.ts"] });
    await remember(deps, { type: "bugfix", body: "second note body", anchors: ["src/a.ts"] });

    const entries = await stagingList(deps);

    expect(entries.length).toBe(2);
    const first = entries.find((entry) => entry.id === ulid(0))!;
    expect(first.digest).toBe("first digest line");
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
    await remember(deps, { type: "pattern", body: "mixed anchors", anchors: ["src/a.ts", "src/gone.ts"] });

    const entries = await stagingList(deps);

    expect(entries[0]!.anchors).toEqual([
      { path: "src/a.ts", liveness: "tracked" },
      { path: "src/gone.ts", liveness: "missing" },
    ]);
  });

  test("classifies an anchor present on disk but not git-tracked as untracked-exists, not missing", async () => {
    const projectRoot = await buildProjectRepo();
    writeFileSync(join(projectRoot, "src/fresh.ts"), "created this session\n");
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "fresh harvest", anchors: ["src/fresh.ts"] });

    const entries = await stagingList(deps);

    expect(entries[0]!.anchors).toEqual([{ path: "src/fresh.ts", liveness: "untracked-exists" }]);
  });

  test("staging_listed carries per-entry anchor liveness telemetry", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "note one", anchors: ["src/a.ts", "src/gone.ts"] });

    await stagingList(deps);

    const listed = eventsOfType(deps.corpus, "staging_listed");
    expect(listed[0]!.liveness).toEqual([
      {
        id: ulid(0),
        anchors: [
          { path: "src/a.ts", liveness: "tracked" },
          { path: "src/gone.ts", liveness: "missing" },
        ],
      },
    ]);
  });
});

describe("stagingList dedup honesty", () => {
  const targetBody = "original decision rationale";
  const newBody = "revised decision rationale";

  test("reports dedup unavailable for a degraded sidecar rather than claiming no neighbor", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "degraded dedup", anchors: ["src/a.ts"] });

    const entries = await stagingList(deps);

    expect(entries[0]!.dedup).toEqual({ kind: "unavailable" });
  });

  test("reports dedup unavailable without crashing when the sidecar is absent", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, offlineClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "no sidecar note", anchors: ["src/a.ts"] });
    rmSync(join(deps.corpus.stagingDir, `${ulid(0)}.dedup.json`));

    const entries = await stagingList(deps);

    expect(entries[0]!.dedup).toEqual({ kind: "unavailable" });
  });

  test("reports no close neighbor when dedup ran and found nothing near", async () => {
    const projectRoot = await buildProjectRepo();
    const deps = await makeDeps(projectRoot, bagClient(), sequentialIds());
    await remember(deps, { type: "pattern", body: "lonely note about widgets", anchors: ["src/a.ts"] });

    const entries = await stagingList(deps);

    expect(entries[0]!.dedup).toEqual({ kind: "no_neighbor" });
  });

  test("surfaces the nearest neighbor when dedup offers a supersede", async () => {
    const projectRoot = await buildProjectRepo();
    const embeddings = keyedClient(new Map([[targetBody, [1, 0]], [newBody, [75, 40]]]));
    const deps = await makeDeps(projectRoot, embeddings, sequentialIds());
    await remember(deps, { type: "decision", body: targetBody, anchors: ["src/a.ts"] });
    const targetId = ulid(0);
    await stagingResolve(deps, targetId, "accept");
    await remember(deps, { type: "decision", body: newBody, anchors: ["src/a.ts"] });

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
