import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "./corpus";
import type { StagedClassification } from "./dedup-sidecar";
import { DEDUP_RELATIONS } from "./event-schema";
import type { DedupRelation } from "./event-schema";
import type { ChoiceQuestion, JudgeClient } from "./judge";
import { parseNote } from "./note";
import type { NoteType } from "./note";

// The judge's ONE question about a staged note A and its nearest accepted neighbour B, and the
// verdict it yields. The judge ADVISES: the verdict never changes the cosine classification (add /
// supersede_offer / noop), never writes `supersedes`, and never drops a note. It rides into the
// sidecar, the remember event and the staging card, so the human decides with the cosine similarity
// and the judge's reading side by side. It is asked whenever a neighbour exists at all — a real
// supersede often sits BELOW the cosine offer threshold (four of the six in the probe did) — and never
// for a noop, which stages nothing.

// Recommendation threshold over P(supersedes) + P(contradicts). Origin: the 2026-11-07 probe over
// 597 staged-note × nearest-neighbour pairs of the mneme and mneme-plugin corpora — at 0.8 the judge
// offered 18 supersedes and hit all 6 the human had actually made, where cosine offered 41 and hit 2.
// Six positives on two corpora of one author is an indication, not a calibration, and Jev's
// probabilities are neither calibrated nor stable across model versions, so this stays a spec
// constant rather than a config knob until a calibration on the staging_resolve log replaces it.
export const JUDGE_SUPERSEDE_THRESHOLD = 0.8;

export const DEDUP_JUDGE_CONTEXT =
  "Two notes from a personal engineering memory about one codebase. Note A was just written and is " +
  "being reviewed. Note B was accepted into the memory earlier.";

// Typed by the event registry's relations, so the question's options and the logged enum cannot
// drift apart: a relation missing here fails the type check.
const DEDUP_RELATION_CRITERIA: Record<DedupRelation, string> = {
  duplicate: "A restates what B already says and adds nothing",
  supersedes: "A updates or corrects B, so B should be retired",
  contradicts: "A and B disagree and neither clearly replaces the other",
  complements: "A adds new facts about the same subject and both notes should stay",
  unrelated: "A and B are about different subjects",
};

export const DEDUP_RELATION_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions: "How does note A relate to note B?",
  criteria: DEDUP_RELATION_CRITERIA,
};

// What the judge sees of a note: its type, concept tags, anchors and whole body — the same four
// fields the curator sees on the staging card.
export interface JudgedNote {
  type: NoteType;
  tags: string[];
  anchors: string[];
  body: string;
}

// neighborId names the note the judge compared against. The sidecar drops the neighbour of an `add`
// (its cosine was below the offer threshold, so the card says "no close neighbor"), and the verdict
// is the only place that still knows whom a recommendation points at.
export type JudgeVerdict =
  | {
      degraded: false;
      model: string;
      neighborId: string;
      relation: DedupRelation;
      probabilities: Record<DedupRelation, number>;
      confidence: number;
      recommended: boolean;
    }
  | { degraded: true; model: string; neighborId: string };

export interface JudgeNeighborDeps {
  corpus: Pick<Corpus, "notesDir">;
  // Absent when no key is configured: then every verdict is null and nothing else changes.
  judge?: JudgeClient;
}

// null = no judge configured, or no neighbour to judge; degraded = the judge was asked and did not
// answer usably. Everything else is a verdict with the recommendation already derived, so no reader
// re-applies a threshold that may have moved since.
export async function judgeNeighbor(
  deps: JudgeNeighborDeps,
  candidate: JudgedNote,
  classification: StagedClassification,
): Promise<JudgeVerdict | null> {
  if (deps.judge === undefined || classification.neighborId === null) {
    return null;
  }
  const neighborId = classification.neighborId;
  const model = deps.judge.model;
  const neighbor = readJudgedNote(deps.corpus.notesDir, neighborId);
  if (neighbor === undefined) {
    return { degraded: true, model, neighborId };
  }
  const result = await deps.judge.judge(
    { context: DEDUP_JUDGE_CONTEXT, note_a: candidate, note_b: neighbor },
    { relation: DEDUP_RELATION_QUESTION },
  );
  if (!result.available) {
    return { degraded: true, model, neighborId };
  }
  const answer = result.answers["relation"];
  if (answer === undefined || answer.type !== "choice" || !isDedupRelation(answer.choice)) {
    return { degraded: true, model, neighborId };
  }
  const probabilities = relationProbabilities(answer.probabilities);
  if (probabilities === undefined) {
    return { degraded: true, model, neighborId };
  }
  return {
    degraded: false,
    model,
    neighborId,
    relation: answer.choice,
    probabilities,
    confidence: answer.confidence,
    recommended: probabilities.supersedes + probabilities.contradicts >= JUDGE_SUPERSEDE_THRESHOLD,
  };
}

function isDedupRelation(value: string): value is DedupRelation {
  return (DEDUP_RELATIONS as readonly string[]).includes(value);
}

function relationProbabilities(probabilities: Record<string, number>): Record<DedupRelation, number> | undefined {
  const typed: Partial<Record<DedupRelation, number>> = {};
  for (const relation of DEDUP_RELATIONS) {
    const probability = probabilities[relation];
    if (probability === undefined) {
      return undefined;
    }
    typed[relation] = probability;
  }
  return typed as Record<DedupRelation, number>;
}

// The neighbour comes from the index, which derives from notes/, so its file is expected to exist;
// a corpus whose index ran ahead of its files is a degraded verdict, never a failed remember.
function readJudgedNote(notesDir: string, id: string): JudgedNote | undefined {
  const path = join(notesDir, `${id}.md`);
  if (!existsSync(path)) {
    return undefined;
  }
  const note = parseNote(readFileSync(path, "utf8"));
  return {
    type: note.frontmatter.type,
    tags: note.frontmatter.tags ?? [],
    anchors: note.frontmatter.anchors,
    body: note.body,
  };
}
