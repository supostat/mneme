#!/usr/bin/env bun
import { RECALL_CANDIDATE_WINDOW } from "../../src/event-schema";
import { RRF_K } from "../../src/fusion";
import { RECALL_BUNDLE_COSINE_THRESHOLD, RECALL_LOW_CONFIDENCE_FLOOR, passesRecallThreshold } from "../../src/recall";
import type { IngestMode } from "./ingest";
import type { CaseObservation, QuestionObservation } from "./run";

// Deterministic retrieval metrics over logged recall events. Ranking (Recall@k) reads the
// pre-threshold candidates window in fused order; abstention reads the final returned_ids,
// with the cold-start floor detected through the engine's OWN threshold predicate
// (passesRecallThreshold) — no second scorer, the live rule judges its own output.
//
// A hit is SESSION-level: a session counts as retrieved when any of its chunk notes
// appears in the top-k candidates (the chunking decision keeps evidence at session level).

export const RECALL_KS = [5, 10] as const;

export interface RecallAtK {
  k: number;
  value: number;
}

export interface ModeReport {
  mode: IngestMode;
  cases: number;
  answerable: { questions: number; recallAtK: RecallAtK[]; abstained: number };
  abstention: { questions: number; abstained: number };
  knowledgeUpdate: {
    questions: number;
    updateRecallAtK: RecallAtK[];
    staleHitAtK: RecallAtK[];
  };
}

export interface ModeDelta {
  updateRecallAtK: RecallAtK[];
  staleHitAtK: RecallAtK[];
}

export interface BenchProvenance {
  dataset: string;
  datasetSha256: string | null;
  budget: number;
  embedderModelConfigured: string | null;
  embedderModelIndexStamp: string | null;
}

export interface BenchReport {
  provenance: BenchProvenance;
  params: {
    cosineThreshold: number;
    lowConfidenceFloor: number;
    rrfK: number;
    candidateWindow: number;
  };
  modes: ModeReport[];
  delta: ModeDelta | null;
}

// A session is retrieved at k when any of its chunk notes sits in the top-k candidates.
function sessionHitAtK(observation: QuestionObservation, sessionByNoteId: Map<string, string>, sessionId: string, k: number): boolean {
  return observation.candidates
    .slice(0, k)
    .some((candidate) => sessionByNoteId.get(candidate.id) === sessionId);
}

function questionRecallAtK(observation: QuestionObservation, sessionByNoteId: Map<string, string>, k: number): number {
  const evidence = observation.evidenceSessionIds;
  if (evidence.length === 0) return 0;
  const hits = evidence.filter((sessionId) => sessionHitAtK(observation, sessionByNoteId, sessionId, k)).length;
  return hits / evidence.length;
}

// Abstention: the final return is empty, or nothing in it passes the live threshold
// predicate — the latter is exactly the cold-start floor's signature. A returned id
// outside the logged candidate window cannot be judged and conservatively counts as
// passing (never inflating the abstention rate).
export function abstained(observation: QuestionObservation): boolean {
  if (observation.returnedIds.length === 0) return true;
  const candidateById = new Map(observation.candidates.map((candidate) => [candidate.id, candidate]));
  return observation.returnedIds.every((returnedId) => {
    const candidate = candidateById.get(returnedId);
    if (candidate === undefined) return false;
    return !passesRecallThreshold({
      id: candidate.id,
      body: "",
      ftsRank: candidate.fts_rank,
      cosine: candidate.cosine,
      lowConfidence: false,
    });
  });
}

interface QuestionInContext {
  observation: QuestionObservation;
  sessionByNoteId: Map<string, string>;
}

export function aggregateMode(mode: IngestMode, cases: CaseObservation[]): ModeReport {
  const questions: QuestionInContext[] = cases.flatMap((caseObservation) =>
    caseObservation.questions.map((observation) => ({
      observation,
      sessionByNoteId: caseObservation.sessionByNoteId,
    })),
  );
  const answerable = questions.filter(
    ({ observation }) => observation.category !== "abstention" && observation.evidenceSessionIds.length > 0,
  );
  const abstentionQuestions = questions.filter(({ observation }) => observation.category === "abstention");
  const updates = questions.filter(({ observation }) => observation.category === "knowledge-update");
  return {
    mode,
    cases: cases.length,
    answerable: {
      questions: answerable.length,
      recallAtK: RECALL_KS.map((k) => ({
        k,
        value: average(answerable.map(({ observation, sessionByNoteId }) => questionRecallAtK(observation, sessionByNoteId, k))),
      })),
      abstained: answerable.filter(({ observation }) => abstained(observation)).length,
    },
    abstention: {
      questions: abstentionQuestions.length,
      abstained: abstentionQuestions.filter(({ observation }) => abstained(observation)).length,
    },
    knowledgeUpdate: {
      questions: updates.length,
      updateRecallAtK: RECALL_KS.map((k) => ({
        k,
        value: average(updates.map(({ observation, sessionByNoteId }) => (updateTargetHit(observation, sessionByNoteId, k) ? 1 : 0))),
      })),
      staleHitAtK: RECALL_KS.map((k) => ({
        k,
        value: average(updates.map(({ observation, sessionByNoteId }) => (staleHit(observation, sessionByNoteId, k) ? 1 : 0))),
      })),
    },
  };
}

// The update target is the LAST session of the evidence chain (haystack order is
// chronological); every earlier evidence session is the outdated version whose top-k
// appearance counts as a stale hit.
function updateTargetHit(observation: QuestionObservation, sessionByNoteId: Map<string, string>, k: number): boolean {
  const target = observation.evidenceSessionIds[observation.evidenceSessionIds.length - 1];
  return target !== undefined && sessionHitAtK(observation, sessionByNoteId, target, k);
}

function staleHit(observation: QuestionObservation, sessionByNoteId: Map<string, string>, k: number): boolean {
  return observation.evidenceSessionIds
    .slice(0, -1)
    .some((sessionId) => sessionHitAtK(observation, sessionByNoteId, sessionId, k));
}

export function buildReport(
  provenance: BenchProvenance,
  observationsByMode: Map<IngestMode, CaseObservation[]>,
): BenchReport {
  const modes = [...observationsByMode.entries()].map(([mode, cases]) => aggregateMode(mode, cases));
  const coexist = modes.find((report) => report.mode === "coexist");
  const supersede = modes.find((report) => report.mode === "supersede");
  return {
    provenance,
    params: {
      cosineThreshold: RECALL_BUNDLE_COSINE_THRESHOLD,
      lowConfidenceFloor: RECALL_LOW_CONFIDENCE_FLOOR,
      rrfK: RRF_K,
      candidateWindow: RECALL_CANDIDATE_WINDOW,
    },
    modes,
    delta:
      coexist !== undefined && supersede !== undefined
        ? {
            updateRecallAtK: subtract(supersede.knowledgeUpdate.updateRecallAtK, coexist.knowledgeUpdate.updateRecallAtK),
            staleHitAtK: subtract(supersede.knowledgeUpdate.staleHitAtK, coexist.knowledgeUpdate.staleHitAtK),
          }
        : null,
  };
}

export function renderReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`dataset: ${report.provenance.dataset}`);
  lines.push(`dataset sha256: ${report.provenance.datasetSha256 ?? "n/a (fixture run)"}`);
  lines.push(`recall budget (per call): ${report.provenance.budget}`);
  lines.push(`embedder model (configured): ${report.provenance.embedderModelConfigured ?? "n/a"}`);
  lines.push(`embedder model (index stamp): ${report.provenance.embedderModelIndexStamp ?? "n/a"}`);
  lines.push(
    `params: cosine threshold ${report.params.cosineThreshold} · low-confidence floor ${report.params.lowConfidenceFloor} · ` +
      `RRF k ${report.params.rrfK} · candidate window ${report.params.candidateWindow}`,
  );
  for (const mode of report.modes) {
    lines.push("");
    lines.push(`mode ${mode.mode} — ${mode.cases} case(s)`);
    lines.push(
      `  answerable (${mode.answerable.questions}): ` +
        `${mode.answerable.recallAtK.map((entry) => `Recall@${entry.k} ${format(entry.value)}`).join(" · ")} · ` +
        `false abstention ${mode.answerable.abstained}/${mode.answerable.questions}`,
    );
    lines.push(`  abstention (${mode.abstention.questions}): abstained ${mode.abstention.abstained}/${mode.abstention.questions}`);
    lines.push(
      `  knowledge-update (${mode.knowledgeUpdate.questions}): ` +
        `${mode.knowledgeUpdate.updateRecallAtK.map((entry) => `update Recall@${entry.k} ${format(entry.value)}`).join(" · ")} · ` +
        `${mode.knowledgeUpdate.staleHitAtK.map((entry) => `stale hit@${entry.k} ${format(entry.value)}`).join(" · ")}`,
    );
  }
  if (report.delta !== null) {
    lines.push("");
    lines.push("delta (supersede − coexist, knowledge-update subset):");
    lines.push(`  ${report.delta.updateRecallAtK.map((entry) => `update Recall@${entry.k} ${formatSigned(entry.value)}`).join(" · ")}`);
    lines.push(`  ${report.delta.staleHitAtK.map((entry) => `stale hit@${entry.k} ${formatSigned(entry.value)}`).join(" · ")}`);
  }
  return lines.join("\n");
}

function subtract(left: RecallAtK[], right: RecallAtK[]): RecallAtK[] {
  return left.map((entry, index) => ({ k: entry.k, value: entry.value - (right[index]?.value ?? 0) }));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function format(value: number): string {
  return value.toFixed(3);
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}
