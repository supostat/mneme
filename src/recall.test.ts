import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, initRepo } from "./git";
import { serializeNote } from "./note";
import type { Note, NoteFrontmatter } from "./note";
import { rebuild } from "./index-db";
import { recall } from "./recall";
import type { RecallDeps } from "./recall";
import { EMBEDDING_DIMENSION } from "./embeddings";
import type { EmbeddingsClient } from "./embeddings";
import { EventWriter, readEvents } from "./events";
import type { StoredEvent } from "./events";
import { estimateTokens } from "./fusion";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(n: number): string {
  const base = "01ARZ3NDEKTSV4RRFFQ69G5F";
  return base + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

const baseFrontmatter: NoteFrontmatter = {
  id: ulid(0),
  type: "pattern",
  anchors: ["src/a.ts"],
  commit: "abc1234",
  created: "2026-07-06T10:00:00.000Z",
};

interface NoteSpec {
  id: string;
  body: string;
  anchor: string;
  dead?: boolean;
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

function bagOfWordsClient(): EmbeddingsClient {
  return {
    embed: async (inputs) => ({ available: true, embeddings: inputs.map(bagVector), retries: 0 }),
  };
}

function offlineClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : { available: false, embeddings: [], retries: 0 },
  };
}

async function buildProjectRepo(fileNames: string[]): Promise<{ projectRoot: string; commit: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-recall-proj-"));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (const name of fileNames) writeFileSync(join(projectRoot, name), `content of ${name}\n`);
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { projectRoot, commit };
}

async function setupIndex(
  specs: NoteSpec[],
  embeddings: EmbeddingsClient,
): Promise<{ indexPath: string; eventsDir: string }> {
  const liveFiles = specs.filter((spec) => !spec.dead).map((spec) => spec.anchor);
  const { projectRoot, commit } = await buildProjectRepo(liveFiles);
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-recall-"));
  const notesDir = join(corpusDir, "notes");
  const eventsDir = join(corpusDir, "events");
  mkdirSync(notesDir);
  mkdirSync(eventsDir);
  for (const spec of specs) {
    const note: Note = {
      frontmatter: { ...baseFrontmatter, id: spec.id, anchors: [spec.anchor], commit },
      body: spec.body,
    };
    writeFileSync(join(notesDir, `${spec.id}.md`), serializeNote(note));
  }
  const indexPath = join(corpusDir, "index.db");
  // The rebuild event goes to a throwaway dir, keeping the returned eventsDir holding only the events
  // the recall tests assert on.
  const buildEventsDir = mkdtempSync(join(tmpdir(), "mneme-recall-build-events-"));
  const eventWriter = new EventWriter(buildEventsDir, {
    sessionId: "s-recall-build",
    mnemeVersion: "0.1.0",
    clock: () => new Date("2026-07-06T10:00:00.000Z"),
  });
  await rebuild({ indexPath, notesDir, projectRoot, embeddings, eventWriter, clock: () => new Date("2026-07-06T10:00:00.000Z") });
  return { indexPath, eventsDir };
}

const RECALL_CLOCK = (): Date => new Date("2026-07-06T10:00:00.000Z");

function openRecall(
  indexPath: string,
  eventsDir: string,
  embeddings: EmbeddingsClient,
): RecallDeps & { db: Database } {
  const db = new Database(indexPath, { readonly: true });
  const eventWriter = new EventWriter(eventsDir, {
    sessionId: "session-recall",
    mnemeVersion: "0.1.0",
    clock: RECALL_CLOCK,
  });
  return { db, embeddings, eventWriter, clock: RECALL_CLOCK };
}

function tokenEstimate(body: string): number {
  return Math.ceil(Buffer.byteLength(body, "utf8") / 4);
}

const FILLER_BODIES = [
  "caching strategy for read heavy endpoints",
  "database migration rollback procedure",
  "structured logging conventions across services",
  "retry policy with exponential backoff",
  "connection pool sizing guidance",
  "graceful shutdown sequence for workers",
  "feature flag rollout mechanics",
  "timezone handling in scheduled jobs",
  "idempotency keys for external calls",
  "circuit breaker thresholds tuning",
  "pagination cursor encoding scheme",
  "rate limiter token bucket design",
  "background queue draining approach",
  "secret rotation without downtime",
  "health probe endpoint semantics",
  "audit trail append only storage",
  "schema versioning strategy notes",
  "deadlock avoidance ordering rule",
  "memory profiling under load spikes",
  "graceful degradation of optional features",
];

describe("recall FTS regression", () => {
  test("an inflected query stems to its plural via porter", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "payments are reconciled nightly", anchor: "src/pay.ts" },
      { id: ulid(1), body: "unrelated caching guidance here", anchor: "src/cache.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, offlineClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    const result = await recall(deps, "payment", 10000);

    expect(result.returnedIds).toEqual([ulid(0)]);
  });

  test("a compound identifier is split into prefixed terms", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "migrate the react-hook-form resolver to zod", anchor: "src/forms.ts" },
      { id: ulid(1), body: "unrelated caching guidance here", anchor: "src/cache.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, offlineClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    const result = await recall(deps, "react-hook-form", 10000);

    expect(result.returnedIds).toContain(ulid(0));
  });

  test("fts operator characters in the query do not throw and still match", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "payments are reconciled nightly", anchor: "src/pay.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, offlineClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    const result = await recall(deps, 'payment "NEAR" (foo*) OR', 10000);

    expect(result.returnedIds).toContain(ulid(0));
  });
});

describe("recall budget", () => {
  const specs: NoteSpec[] = [
    {
      id: ulid(0),
      body: "widget widget widget widget widget alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron",
      anchor: "src/big.ts",
    },
    { id: ulid(1), body: "widget one small", anchor: "src/s1.ts" },
    { id: ulid(2), body: "widget two small", anchor: "src/s2.ts" },
  ];
  const bodyById = new Map(specs.map((spec) => [spec.id, spec.body]));

  test("the summed token estimate never exceeds the budget across budgets", async () => {
    const { indexPath, eventsDir } = await setupIndex(specs, offlineClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    for (const budget of [3, 10, 50, 100000]) {
      const result = await recall(deps, "widget", budget);
      const used = result.returnedIds.reduce((sum, id) => sum + tokenEstimate(bodyById.get(id)!), 0);
      expect(used).toBeLessThanOrEqual(budget);
    }
  });

  test("a budget below the top note skips it and continues filling smaller notes", async () => {
    const { indexPath, eventsDir } = await setupIndex(specs, offlineClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    const roomy = await recall(deps, "widget", 100000);
    expect(roomy.returnedIds[0]).toBe(ulid(0));

    const result = await recall(deps, "widget", 10);

    expect(result.returnedIds).not.toContain(ulid(0));
    expect(result.returnedIds).toContain(ulid(1));
    expect(result.returnedIds).toContain(ulid(2));
  });
});

describe("recall degraded mode", () => {
  test("an unavailable embedder degrades to FTS-and-staleness ordering without emptying results", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "payment refund ledger reconciliation", anchor: "src/pay.ts" },
      { id: ulid(1), body: "caching guidance for reads", anchor: "src/cache.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    const result = await recall(deps, "payment refund ledger", 10000);

    expect(result.degraded).toBe(true);
    expect(result.returnedIds[0]).toBe(ulid(0));
  });
});

describe("recall degraded on empty vector table", () => {
  test("an available embedder still degrades when the index holds zero vectors, yet FTS returns results", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "payment refund ledger reconciliation", anchor: "src/pay.ts" },
      { id: ulid(1), body: "caching guidance for reads", anchor: "src/cache.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, offlineClient());
    const deps = openRecall(indexPath, eventsDir, bagOfWordsClient());

    const result = await recall(deps, "payment refund ledger", 10000);

    expect(result.degraded).toBe(true);
    expect(result.returnedIds).toContain(ulid(0));
  });
});

describe("recall relevance in both modes", () => {
  function corpusSpecs(): NoteSpec[] {
    const paymentNote: NoteSpec = {
      id: ulid(0),
      body: "payment refund ledger reconciliation nightly",
      anchor: "src/payments.ts",
    };
    const fillers: NoteSpec[] = FILLER_BODIES.map((body, index) => ({
      id: ulid(index + 1),
      body,
      anchor: `src/filler${index}.ts`,
    }));
    return [paymentNote, ...fillers];
  }

  test("the relevant note tops both the fused and the degraded ranking (>=20-note corpus)", async () => {
    const specs = corpusSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(20);
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    const fused = await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "payment refund ledger", 100000);
    const degraded = await recall(openRecall(indexPath, eventsDir, offlineClient()), "payment refund ledger", 100000);

    expect(fused.degraded).toBe(false);
    expect(fused.returnedIds[0]).toBe(ulid(0));
    expect(degraded.degraded).toBe(true);
    expect(degraded.returnedIds[0]).toBe(ulid(0));
  });
});

describe("recall dead-anchor sink", () => {
  test("a dead-anchor note ranks below a live note it would otherwise tie", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "singleton pattern usage guide", anchor: "src/live.ts" },
      { id: ulid(1), body: "singleton pattern reference material", anchor: "src/ghost.ts", dead: true },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    const deps = openRecall(indexPath, eventsDir, bagOfWordsClient());

    const result = await recall(deps, "singleton pattern", 100000);

    expect(result.returnedIds).toContain(ulid(0));
    expect(result.returnedIds).toContain(ulid(1));
    expect(result.returnedIds.indexOf(ulid(0))).toBeLessThan(result.returnedIds.indexOf(ulid(1)));
  });
});

describe("recall empty query", () => {
  test("a query with neither FTS terms nor a vector signal returns nothing yet appends an event (up)", async () => {
    const specs: NoteSpec[] = [{ id: ulid(0), body: "payment refund ledger", anchor: "src/pay.ts" }];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    const deps = openRecall(indexPath, eventsDir, bagOfWordsClient());

    // "%%% ---" yields no FTS terms and a zero-norm bag vector, so both channels stay empty.
    const result = await recall(deps, "%%% ---", 10000);

    expect(result.returnedIds).toEqual([]);
    const events = readEvents(eventsDir);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("recall");
    expect(events[0]!.returned_ids).toEqual([]);
    expect(events[0]!.degraded).toBe(false);
  });

  test("a term-less query still appends an event when the embedder is down", async () => {
    const specs: NoteSpec[] = [{ id: ulid(0), body: "payment refund ledger", anchor: "src/pay.ts" }];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    const deps = openRecall(indexPath, eventsDir, offlineClient());

    const result = await recall(deps, "%%% ---", 10000);

    expect(result.returnedIds).toEqual([]);
    const events = readEvents(eventsDir);
    expect(events.length).toBe(1);
    expect(events[0]!.degraded).toBe(true);
  });
});

describe("recall malformed vector skip", () => {
  test("a malformed embedding on an indexed note is skipped from cosine so its well-formed peer ranks first", async () => {
    // Both notes share one body: identical FTS relevance and (both live at HEAD) zero staleness,
    // so the only thing separating them is cosine. ulid(0)'s stored vector is then corrupted to a
    // 3-byte blob. With the floatsFromBlob guard, ulid(0) is dropped from cosine and only ulid(1)
    // earns a cosine rank, lifting it above ulid(0). Without the guard, the 3-byte blob yields a
    // NaN cosine score that sorts ulid(0) to cosine rank 1, polluting the fusion and pushing ulid(0)
    // back to the top -- which breaks this test's ulid(1)-first expectation.
    const body = "payment refund ledger reconciliation";
    const specs: NoteSpec[] = [
      { id: ulid(0), body, anchor: "src/pay.ts" },
      { id: ulid(1), body, anchor: "src/cache.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    const writable = new Database(indexPath);
    writable.run("UPDATE vec SET embedding = ? WHERE id = ?", [new Uint8Array(3), ulid(0)]);
    writable.close();

    const deps = openRecall(indexPath, eventsDir, bagOfWordsClient());
    const result = await recall(deps, "payment refund ledger", 100000);

    expect(result.degraded).toBe(false);
    expect(result.returnedIds).toContain(ulid(0));
    expect(result.returnedIds).toContain(ulid(1));
    expect(result.returnedIds[0]).toBe(ulid(1));
  });

  test("a byte-aligned but wrong-dimension embedding is skipped from cosine so its well-formed peer ranks first", async () => {
    // Same fixture as the malformed-vector test: two notes share one body, so cosine is the sole
    // differentiator. ulid(0)'s vector is overwritten with an 8-byte blob -- 4-byte aligned yet only
    // two floats instead of EMBEDDING_DIMENSION. A byte-alignment-only guard would accept it, letting
    // cosineSimilarity read past the two floats into undefined and produce NaN that sorts ulid(0) to
    // cosine rank 1. The exact-dimension guard drops it, so only ulid(1) earns a cosine rank and leads.
    const body = "payment refund ledger reconciliation";
    const specs: NoteSpec[] = [
      { id: ulid(0), body, anchor: "src/pay.ts" },
      { id: ulid(1), body, anchor: "src/cache.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    const writable = new Database(indexPath);
    writable.run("UPDATE vec SET embedding = ? WHERE id = ?", [new Uint8Array(8), ulid(0)]);
    writable.close();

    const deps = openRecall(indexPath, eventsDir, bagOfWordsClient());
    const result = await recall(deps, "payment refund ledger", 100000);

    expect(result.degraded).toBe(false);
    expect(result.returnedIds).toContain(ulid(0));
    expect(result.returnedIds).toContain(ulid(1));
    expect(result.returnedIds[0]).toBe(ulid(1));
  });
});

describe("recall cross-lingual and mixed queries", () => {
  // A multilingual embedder maps a Cyrillic query to the same concept vector as an English note.
  function crossLingualClient(translations: Map<string, string>): EmbeddingsClient {
    return {
      embed: async (inputs) => ({
        available: true,
        embeddings: inputs.map((input) => bagVector(translations.get(input) ?? input)),
        retries: 0,
      }),
    };
  }

  test("a Cyrillic query with no FTS-matchable tokens still recalls its nearest note via cosine", async () => {
    const targetBody = "wal lock contention during concurrent rebuild";
    const specs: NoteSpec[] = [
      { id: ulid(0), body: targetBody, anchor: "src/wal.ts" },
      { id: ulid(1), body: "caching guidance for read heavy endpoints", anchor: "src/cache.ts" },
      { id: ulid(2), body: "structured logging conventions across services", anchor: "src/log.ts" },
    ];
    const cyrillicQuery = "блокировка при конкурентной перестройке индекса";
    const translations = new Map([[cyrillicQuery, targetBody]]);
    const { indexPath, eventsDir } = await setupIndex(specs, crossLingualClient(translations));

    // Control: with the embedder down only the FTS channel runs. The widened extractTerms sends the
    // Cyrillic terms into `"term"*` MATCH syntax, so this run also pins that unicode61 tolerates
    // quoted unicode prefixes -- an empty rank map, never a raised error -- and that a query the
    // vector channel cannot serve honestly reports degradation instead of a silent empty hit.
    const control = await recall(openRecall(indexPath, eventsDir, offlineClient()), cyrillicQuery, 100000);
    expect(control.returnedIds).toEqual([]);
    expect(control.degraded).toBe(true);

    const result = await recall(openRecall(indexPath, eventsDir, crossLingualClient(translations)), cyrillicQuery, 100000);
    // Served purely by cosine: a live embedder with stored vectors is the normal mode, not degraded.
    expect(result.degraded).toBe(false);
    expect(result.returnedIds[0]).toBe(ulid(0));
  });

  test("a mixed Russian-and-English query feeds both channels without either suppressing the other", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "payment flow retry and refund handling", anchor: "src/pay.ts" },
      { id: ulid(1), body: "caching guidance for read heavy endpoints", anchor: "src/cache.ts" },
      { id: ulid(2), body: "structured logging conventions across services", anchor: "src/log.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    const deps = openRecall(indexPath, eventsDir, bagOfWordsClient());

    // "починить" carries no index token; "payment"/"flow" drive FTS while the whole string drives the
    // vector. Both channels vote the payments note first -- neither the latin terms nor the prose wins alone.
    const result = await recall(deps, "починить payment flow", 100000);

    expect(result.degraded).toBe(false);
    expect(result.returnedIds[0]).toBe(ulid(0));
  });
});

describe("recall RRF determinism", () => {
  test("bm25 and cosine ties break by ascending id and repeat identically", async () => {
    const specs: NoteSpec[] = [
      { id: ulid(0), body: "identical tie breaker body", anchor: "src/one.ts" },
      { id: ulid(1), body: "identical tie breaker body", anchor: "src/two.ts" },
    ];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    const first = await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "identical tie breaker", 100000);
    const second = await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "identical tie breaker", 100000);

    expect(first.returnedIds).toEqual([ulid(0), ulid(1)]);
    expect(second.returnedIds).toEqual(first.returnedIds);
  });
});

// A client that returns a fixed non-zero vector for any non-empty input, so a query with no FTS
// terms still carries a vector signal — the only way to reach the vector_only channel gate.
function constantVectorClient(): EmbeddingsClient {
  return {
    embed: async (inputs) =>
      inputs.length === 0
        ? { available: true, embeddings: [], retries: 0 }
        : {
            available: true,
            embeddings: inputs.map(() => {
              const vector = new Float32Array(EMBEDDING_DIMENSION);
              vector[0] = 1;
              return vector;
            }),
            retries: 0,
          },
  };
}

function lastRecallEvent(eventsDir: string): StoredEvent {
  const recalls = readEvents(eventsDir).filter((event) => event.type === "recall");
  return recalls[recalls.length - 1]!;
}

function candidatesOf(event: StoredEvent): Array<Record<string, unknown>> {
  return event.candidates as Array<Record<string, unknown>>;
}

describe("recall candidate logging", () => {
  test("logs the top-20 candidate window and the full corpus size on a 21-note corpus", async () => {
    const specs: NoteSpec[] = Array.from({ length: 21 }, (_, index) => ({
      id: ulid(index),
      body: `widget subject matter number ${index}`,
      anchor: `src/w${index}.ts`,
    }));
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "widget", 100000);

    const event = lastRecallEvent(eventsDir);
    expect(candidatesOf(event).length).toBe(20);
    expect(event.corpus_size).toBe(21);
  });

  test("token_est on a candidate equals the body's four-byte estimate", async () => {
    const body = "payment refund ledger reconciliation nightly job";
    const specs: NoteSpec[] = [{ id: ulid(0), body, anchor: "src/pay.ts" }];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "payment refund", 100000);

    const candidate = candidatesOf(lastRecallEvent(eventsDir)).find((entry) => entry.id === ulid(0))!;
    expect(candidate.token_est).toBe(estimateTokens(body));
  });

  test("timings carry three non-negative channel durations", async () => {
    const specs: NoteSpec[] = [{ id: ulid(0), body: "payment refund ledger", anchor: "src/pay.ts" }];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "payment refund", 100000);

    const timings = lastRecallEvent(eventsDir).timings as Record<string, number>;
    expect(Object.keys(timings).sort()).toEqual(["embed_ms", "fts_ms", "fusion_ms"]);
    for (const value of Object.values(timings)) expect(value).toBeGreaterThanOrEqual(0);
  });

  test("RecallResult still exposes exactly returnedIds, notes and degraded", async () => {
    const specs: NoteSpec[] = [{ id: ulid(0), body: "payment refund ledger", anchor: "src/pay.ts" }];
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());

    const result = await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "payment refund", 100000);

    expect(Object.keys(result).sort()).toEqual(["degraded", "notes", "returnedIds"]);
  });
});

describe("recall mode derivation", () => {
  const specs: NoteSpec[] = [
    { id: ulid(0), body: "payment refund ledger reconciliation", anchor: "src/pay.ts" },
    { id: ulid(1), body: "caching guidance for reads", anchor: "src/cache.ts" },
  ];

  test("both channels active is fused", async () => {
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    await recall(openRecall(indexPath, eventsDir, bagOfWordsClient()), "payment refund", 100000);
    expect(lastRecallEvent(eventsDir).mode).toBe("fused");
  });

  test("terms with an unavailable embedder is fts_only", async () => {
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    await recall(openRecall(indexPath, eventsDir, offlineClient()), "payment refund", 100000);
    expect(lastRecallEvent(eventsDir).mode).toBe("fts_only");
  });

  test("a term-less query with a live vector signal is vector_only", async () => {
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    // "%%% ---" yields no FTS terms; the constant client still returns a non-zero query vector.
    await recall(openRecall(indexPath, eventsDir, constantVectorClient()), "%%% ---", 100000);
    expect(lastRecallEvent(eventsDir).mode).toBe("vector_only");
  });

  test("neither channel active is none", async () => {
    const { indexPath, eventsDir } = await setupIndex(specs, bagOfWordsClient());
    await recall(openRecall(indexPath, eventsDir, offlineClient()), "%%% ---", 100000);
    expect(lastRecallEvent(eventsDir).mode).toBe("none");
  });
});
