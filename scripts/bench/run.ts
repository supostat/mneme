#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import packageJson from "../../package.json";
import type { EmbeddingsClient } from "../../src/embeddings";
import { eventSchema } from "../../src/event-schema";
import { EventWriter, readEvents } from "../../src/events";
import { recall } from "../../src/recall";
import type { IngestMode, IngestedCase } from "./ingest";
import type { BenchQuestion, QuestionCategory } from "./normalize";

// Runs a case's questions against its ingested corpus through the LIVE recall path and
// reads the measurements back from the event log — the recall event is the single source
// of truth the metrics are computed from, exactly as the methodology declares.
//
// The per-call budget is deliberately far above the production default: the benchmark
// isolates the ranking and the threshold, so the token fill must never be the reason a
// threshold-passing note misses returned_ids. The value is pinned into the report.

export const BENCH_RECALL_BUDGET = 100_000;

export class BenchRunError extends Error {}

export interface EventCandidate {
  id: string;
  fts_rank: number | null;
  cosine: number | null;
  rrf: number;
  in_budget: boolean;
}

export interface QuestionObservation {
  questionId: string;
  category: QuestionCategory;
  evidenceSessionIds: string[];
  candidates: EventCandidate[];
  returnedIds: string[];
}

export interface CaseObservation {
  caseId: string;
  mode: IngestMode;
  sessionByNoteId: Map<string, string>;
  questions: QuestionObservation[];
}

export interface RunDeps {
  embeddings: EmbeddingsClient;
  clock?: () => Date;
  budget?: number;
}

export async function runCase(
  ingested: IngestedCase,
  questions: BenchQuestion[],
  deps: RunDeps,
): Promise<CaseObservation> {
  const clock = deps.clock ?? (() => new Date());
  const budget = deps.budget ?? BENCH_RECALL_BUDGET;
  const db = new Database(ingested.indexPath, { readonly: true });
  const eventWriter = new EventWriter(ingested.eventsDir, {
    sessionId: `bench-run-${ingested.mode}`,
    clock,
    mnemeVersion: packageJson.version,
  });
  try {
    for (const question of questions) {
      const result = await recall({ db, embeddings: deps.embeddings, eventWriter, clock }, question.text, budget, "tool-call");
      if (result.degraded) {
        throw new BenchRunError(
          `case ${ingested.caseId}: recall ran degraded (embedder down or vector-less index); ` +
            "the benchmark refuses an FTS-only measurement",
        );
      }
    }
  } finally {
    db.close();
  }
  return {
    caseId: ingested.caseId,
    mode: ingested.mode,
    sessionByNoteId: sessionByNoteId(ingested),
    questions: observationsFromEvents(ingested, questions),
  };
}

function sessionByNoteId(ingested: IngestedCase): Map<string, string> {
  const map = new Map<string, string>();
  for (const session of ingested.sessions) {
    for (const noteId of session.noteIds) {
      map.set(noteId, session.sessionId);
    }
  }
  return map;
}

// Observations come from the LOG, not from the in-process return value: what the event
// carries is what any offline reader would see, so the metrics stay replayable. The last
// event per query wins — bench queries are unique within a case by construction.
function observationsFromEvents(ingested: IngestedCase, questions: BenchQuestion[]): QuestionObservation[] {
  const recallByQuery = new Map<string, { returned_ids: string[]; candidates: EventCandidate[] }>();
  for (const stored of readEvents(ingested.eventsDir)) {
    if (stored.type !== "recall") continue;
    const parsed = eventSchema.safeParse(stored);
    if (!parsed.success || parsed.data.type !== "recall") {
      throw new BenchRunError(`case ${ingested.caseId}: recall event failed schema validation: ${stored.ts}`);
    }
    recallByQuery.set(parsed.data.query, {
      returned_ids: parsed.data.returned_ids,
      candidates: parsed.data.candidates.map((candidate) => ({
        id: candidate.id,
        fts_rank: candidate.fts_rank,
        cosine: candidate.cosine,
        rrf: candidate.rrf,
        in_budget: candidate.in_budget,
      })),
    });
  }
  return questions.map((question) => {
    const event = recallByQuery.get(question.text);
    if (event === undefined) {
      throw new BenchRunError(`case ${ingested.caseId}: no recall event logged for question ${question.id}`);
    }
    return {
      questionId: question.id,
      category: question.category,
      evidenceSessionIds: question.evidenceSessionIds,
      candidates: event.candidates,
      returnedIds: event.returned_ids,
    };
  });
}
