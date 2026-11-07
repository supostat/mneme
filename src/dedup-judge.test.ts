import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEDUP_JUDGE_CONTEXT,
  DEDUP_RELATION_QUESTION,
  JUDGE_SUPERSEDE_THRESHOLD,
  judgeNeighbor,
} from "./dedup-judge";
import type { JudgedNote } from "./dedup-judge";
import type { StagedClassification } from "./dedup-sidecar";
import { DEDUP_RELATIONS } from "./event-schema";
import type { DedupRelation } from "./event-schema";
import type { EmbeddingsHttpRequest, FetchImplementation } from "./embeddings";
import { HttpJudgeClient } from "./judge";
import { serializeNote } from "./note";

// The verdict is tested through the REAL HttpJudgeClient with a stubbed fetch, so these cases pin
// the whole path from a classification to a verdict: what the judge is sent, what comes back, and
// what the caller sees.

const NEIGHBOR_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MODEL = "jev-test";

const CANDIDATE: JudgedNote = {
  type: "decision",
  tags: ["roster"],
  anchors: ["src/a.ts"],
  body: "Decision: the roster has nine cards.",
};

const NEIGHBOR: JudgedNote = {
  type: "decision",
  tags: ["roster", "landing"],
  anchors: ["src/a.ts", "src/b.ts"],
  body: "Decision: the roster has eight cards.",
};

function corpusWithNeighbor(): { notesDir: string } {
  const notesDir = join(mkdtempSync(join(tmpdir(), "mneme-dedup-judge-")), "notes");
  mkdirSync(notesDir);
  writeFileSync(
    join(notesDir, `${NEIGHBOR_ID}.md`),
    serializeNote({
      frontmatter: {
        id: NEIGHBOR_ID,
        type: NEIGHBOR.type,
        anchors: NEIGHBOR.anchors,
        tags: NEIGHBOR.tags,
        commit: "0123456789abcdef0123456789abcdef01234567",
        created: "2026-07-06T10:00:00.000Z",
      },
      body: NEIGHBOR.body,
    }),
  );
  return { notesDir };
}

function addWithNeighbor(): StagedClassification {
  return { kind: "add", degraded: false, neighborId: NEIGHBOR_ID, similarity: 0.6 };
}

function offerWithNeighbor(): StagedClassification {
  return { kind: "supersede_offer", neighborId: NEIGHBOR_ID, similarity: 0.9 };
}

function withoutNeighbor(): StagedClassification {
  return { kind: "add", degraded: false, neighborId: null, similarity: null };
}

interface CallLog {
  count: number;
  lastRequest: EmbeddingsHttpRequest | undefined;
}

function answering(probabilities: Record<DedupRelation, number>, choice: DedupRelation, log: CallLog): FetchImplementation {
  return async (_url, init) => {
    log.count++;
    log.lastRequest = init;
    return {
      ok: true,
      json: async () => ({
        model: MODEL,
        answers: { relation: { type: "choice", choice, probabilities, confidence: 0.77 } },
      }),
    };
  };
}

function failing(log: CallLog): FetchImplementation {
  return async () => {
    log.count++;
    throw new TypeError("connection refused");
  };
}

function judge(fetchImplementation: FetchImplementation): HttpJudgeClient {
  return new HttpJudgeClient("https://judge.test", fetchImplementation, MODEL, "apikey-test");
}

function spread(supersedes: number, contradicts: number): Record<DedupRelation, number> {
  const rest = 1 - supersedes - contradicts;
  return { duplicate: 0, supersedes, contradicts, complements: rest, unrelated: 0 };
}

describe("judgeNeighbor asks only when there is someone to ask", () => {
  test("no neighbour: null, and the judge is never called", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(answering(spread(0.9, 0), "supersedes", log)) }, CANDIDATE, withoutNeighbor());

    expect(verdict).toBeNull();
    expect(log.count).toBe(0);
  });

  test("no judge configured: null, and nothing is fetched", async () => {
    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: undefined }, CANDIDATE, addWithNeighbor());

    expect(verdict).toBeNull();
  });

  test("the state carries the context sentence and both notes whole, the question is the one relation choice", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(answering(spread(0.9, 0), "supersedes", log)) }, CANDIDATE, addWithNeighbor());

    expect(log.count).toBe(1);
    const body = JSON.parse(log.lastRequest!.body) as { model: string; state: unknown; questions: unknown };
    expect(body.model).toBe(MODEL);
    expect(body.state).toEqual({ context: DEDUP_JUDGE_CONTEXT, note_a: CANDIDATE, note_b: NEIGHBOR });
    expect(body.questions).toEqual({ relation: DEDUP_RELATION_QUESTION });
  });

  test("the question's options are exactly the event registry's relations", () => {
    expect(Object.keys(DEDUP_RELATION_QUESTION.criteria).sort()).toEqual([...DEDUP_RELATIONS].sort());
    expect(JUDGE_SUPERSEDE_THRESHOLD).toBe(0.8);
  });
});

describe("judgeNeighbor derives the recommendation at the threshold", () => {
  test("0.5 + 0.25 = 0.75 stays below the threshold", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(answering(spread(0.5, 0.25), "supersedes", log)) }, CANDIDATE, addWithNeighbor());

    expect(verdict).toEqual({
      degraded: false,
      model: MODEL,
      neighborId: NEIGHBOR_ID,
      relation: "supersedes",
      probabilities: spread(0.5, 0.25),
      confidence: 0.77,
      recommended: false,
    });
  });

  test("0.5 + 0.375 = 0.875 recommends", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(answering(spread(0.5, 0.375), "supersedes", log)) }, CANDIDATE, offerWithNeighbor());

    expect(verdict).not.toBeNull();
    expect(verdict!.degraded).toBe(false);
    if (verdict !== null && !verdict.degraded) {
      expect(verdict.recommended).toBe(true);
      expect(verdict.relation).toBe("supersedes");
    }
  });

  test("exactly 0.8 recommends: the boundary is included", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(answering(spread(0.8, 0), "supersedes", log)) }, CANDIDATE, addWithNeighbor());

    expect(verdict !== null && !verdict.degraded && verdict.recommended).toBe(true);
  });

  test("a contradiction counts toward the recommendation and keeps its relation", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(answering(spread(0.1, 0.8), "contradicts", log)) }, CANDIDATE, addWithNeighbor());

    expect(verdict !== null && !verdict.degraded && verdict.recommended).toBe(true);
    expect(verdict !== null && !verdict.degraded && verdict.relation).toBe("contradicts");
  });
});

describe("judgeNeighbor degrades instead of failing", () => {
  test("a judge that does not answer yields a degraded verdict naming the model and the neighbour", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };

    const verdict = await judgeNeighbor({ corpus: corpusWithNeighbor(), judge: judge(failing(log)) }, CANDIDATE, addWithNeighbor());

    expect(verdict).toEqual({ degraded: true, model: MODEL, neighborId: NEIGHBOR_ID });
    expect(log.count).toBe(1);
  });

  test("a neighbour the index names but notes/ no longer holds is a degraded verdict, not a throw", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };
    const emptyNotesDir = join(mkdtempSync(join(tmpdir(), "mneme-dedup-judge-empty-")), "notes");
    mkdirSync(emptyNotesDir);

    const verdict = await judgeNeighbor({ corpus: { notesDir: emptyNotesDir }, judge: judge(answering(spread(0.9, 0), "supersedes", log)) }, CANDIDATE, addWithNeighbor());

    expect(verdict).toEqual({ degraded: true, model: MODEL, neighborId: NEIGHBOR_ID });
    expect(log.count).toBe(0);
  });
});
