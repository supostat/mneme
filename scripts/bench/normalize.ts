#!/usr/bin/env bun

// Parsers for the two benchmark datasets (LoCoMo, LongMemEval-S) into one internal
// shape: a list of retrieval CASES, each a self-contained haystack of sessions plus
// the questions asked over it. LoCoMo yields one case per conversation (its whole QA
// set shares one haystack); LongMemEval-S yields one case per question (every question
// carries its own haystack). Sessions keep their haystack order, which both datasets
// keep chronological — ingest relies on that order to pair knowledge updates.

export type BenchDatasetId = "locomo" | "longmemeval-s";

export const BENCH_DATASET_IDS: BenchDatasetId[] = ["locomo", "longmemeval-s"];

export type QuestionCategory = "standard" | "abstention" | "knowledge-update";

export interface BenchSession {
  id: string;
  date: string | null;
  text: string;
  entities: string[];
}

export interface BenchQuestion {
  id: string;
  text: string;
  category: QuestionCategory;
  evidenceSessionIds: string[];
}

export interface BenchCase {
  id: string;
  sessions: BenchSession[];
  questions: BenchQuestion[];
}

export class NormalizeError extends Error {}

export function parseDataset(dataset: BenchDatasetId, raw: unknown): BenchCase[] {
  return dataset === "locomo" ? parseLocomo(raw) : parseLongmemevalS(raw);
}

const LOCOMO_SESSION_KEY = /^session_(\d+)$/;
const LOCOMO_EVIDENCE_ID = /^D(\d+):\d+$/;
const LOCOMO_ABSTENTION_CATEGORY = 5;
const LONGMEMEVAL_ABSTENTION_SUFFIX = "_abs";

export function parseLocomo(raw: unknown): BenchCase[] {
  return asArray(raw, "locomo root").map((sampleRaw, sampleIndex) => {
    const sample = asRecord(sampleRaw, `locomo sample #${sampleIndex}`);
    const sampleId = asString(sample.sample_id, `locomo sample #${sampleIndex} sample_id`);
    const conversation = asRecord(sample.conversation, `${sampleId} conversation`);
    return {
      id: sampleId,
      sessions: locomoSessions(sampleId, conversation),
      questions: locomoQuestions(sampleId, sample.qa),
    };
  });
}

function locomoSessions(sampleId: string, conversation: Record<string, unknown>): BenchSession[] {
  const sessionNumbers: number[] = [];
  for (const key of Object.keys(conversation)) {
    const match = LOCOMO_SESSION_KEY.exec(key);
    if (match !== null && Array.isArray(conversation[key])) sessionNumbers.push(Number(match[1]));
  }
  sessionNumbers.sort((left, right) => left - right);
  return sessionNumbers.map((sessionNumber) => {
    const turns = asArray(conversation[`session_${sessionNumber}`], `${sampleId} session_${sessionNumber}`);
    const lines: string[] = [];
    const speakers: string[] = [];
    for (const turnRaw of turns) {
      const turn = asRecord(turnRaw, `${sampleId} session_${sessionNumber} turn`);
      if (typeof turn.text !== "string") continue; // image-only turns carry no text
      const speaker = asString(turn.speaker, `${sampleId} session_${sessionNumber} speaker`);
      lines.push(`${speaker}: ${turn.text}`);
      if (!speakers.includes(speaker)) speakers.push(speaker);
    }
    const date = optionalString(conversation[`session_${sessionNumber}_date_time`]);
    return {
      id: `${sampleId}:session_${sessionNumber}`,
      date,
      text: lines.join("\n"),
      entities: date === null ? speakers : [...speakers, date],
    };
  });
}

function locomoQuestions(sampleId: string, qaRaw: unknown): BenchQuestion[] {
  return asArray(qaRaw, `${sampleId} qa`).map((entryRaw, qaIndex) => {
    const entry = asRecord(entryRaw, `${sampleId} qa #${qaIndex}`);
    const category: QuestionCategory =
      entry.category === LOCOMO_ABSTENTION_CATEGORY ? "abstention" : "standard";
    const evidenceSessionIds: string[] = [];
    if (category === "standard") {
      for (const evidenceRaw of asArray(entry.evidence ?? [], `${sampleId} qa #${qaIndex} evidence`)) {
        const evidenceId = asString(evidenceRaw, `${sampleId} qa #${qaIndex} evidence id`);
        const sessionNumber = LOCOMO_EVIDENCE_ID.exec(evidenceId)?.[1];
        if (sessionNumber === undefined) {
          throw new NormalizeError(`${sampleId} qa #${qaIndex} evidence id "${evidenceId}" is not D<session>:<turn>`);
        }
        const sessionId = `${sampleId}:session_${sessionNumber}`;
        if (!evidenceSessionIds.includes(sessionId)) evidenceSessionIds.push(sessionId);
      }
    }
    return {
      id: `${sampleId}:qa-${qaIndex}`,
      text: asString(entry.question, `${sampleId} qa #${qaIndex} question`),
      category,
      evidenceSessionIds,
    };
  });
}

export function parseLongmemevalS(raw: unknown): BenchCase[] {
  return asArray(raw, "longmemeval-s root").map((entryRaw, entryIndex) => {
    const entry = asRecord(entryRaw, `longmemeval-s entry #${entryIndex}`);
    const questionId = asString(entry.question_id, `longmemeval-s entry #${entryIndex} question_id`);
    const questionType = asString(entry.question_type, `${questionId} question_type`);
    const sessionIds = asArray(entry.haystack_session_ids, `${questionId} haystack_session_ids`).map(
      (value, index) => asString(value, `${questionId} haystack_session_ids[${index}]`),
    );
    const sessionBodies = asArray(entry.haystack_sessions, `${questionId} haystack_sessions`);
    if (sessionBodies.length !== sessionIds.length) {
      throw new NormalizeError(`${questionId} haystack_sessions and haystack_session_ids differ in length`);
    }
    const dates = Array.isArray(entry.haystack_dates) ? entry.haystack_dates : [];
    const sessions = sessionIds.map((sessionId, index) =>
      longmemevalSession(questionId, sessionId, sessionBodies[index], optionalString(dates[index])),
    );
    const category: QuestionCategory = questionId.endsWith(LONGMEMEVAL_ABSTENTION_SUFFIX)
      ? "abstention"
      : questionType === "knowledge-update"
        ? "knowledge-update"
        : "standard";
    const evidenceSessionIds =
      category === "abstention"
        ? []
        : asArray(entry.answer_session_ids ?? [], `${questionId} answer_session_ids`).map((value, index) =>
            asString(value, `${questionId} answer_session_ids[${index}]`),
          );
    return {
      id: questionId,
      sessions,
      questions: [
        {
          id: questionId,
          text: asString(entry.question, `${questionId} question`),
          category,
          evidenceSessionIds,
        },
      ],
    };
  });
}

function longmemevalSession(
  questionId: string,
  sessionId: string,
  turnsRaw: unknown,
  date: string | null,
): BenchSession {
  const lines: string[] = [];
  for (const turnRaw of asArray(turnsRaw, `${questionId} session ${sessionId}`)) {
    const turn = asRecord(turnRaw, `${questionId} session ${sessionId} turn`);
    if (typeof turn.content !== "string") continue;
    lines.push(`${asString(turn.role, `${questionId} session ${sessionId} role`)}: ${turn.content}`);
  }
  return { id: sessionId, date, text: lines.join("\n"), entities: date === null ? [] : [date] };
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new NormalizeError(`${what} must be an array`);
  return value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NormalizeError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new NormalizeError(`${what} must be a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
