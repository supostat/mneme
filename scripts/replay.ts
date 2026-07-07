#!/usr/bin/env bun
import { readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { RECALL_CANDIDATE_WINDOW, SCHEMA_VERSION } from "../src/event-schema";
import { DEFAULT_FUSION_PARAMS, fuseAndFill } from "../src/fusion";
import type { FusionDecision, FusionInput, FusionParams } from "../src/fusion";
import { renderAlternative, renderVerification } from "./replay-render";

// Offline "what-if" replay of the recall log. Each schema-v3 recall event carries its pre-budget
// candidate list with the exact fusion inputs and in_budget decision; this tool recomputes the
// decision vector from those LOGGED components alone — never re-running FTS or embeddings and never
// reading the query, so it stays safe against a redacted log. No flags verifies the recorded
// decisions reproduce; any flag reports how alternative parameters would reshape them.

// Candidates first appear at schema v3; an older recall event carries none and is skipped, not failed.
const CANDIDATES_MIN_SCHEMA_VERSION = 3;
const USAGE = "usage: bun scripts/replay.ts <events-dir> [--budget N] [--rrf-k N] [--fts-weight W] [--vector-weight W] [--staleness-weight W]";

export interface ReplayOverrides {
  budget?: number;
  rrfK?: number;
  ftsWeight?: number;
  vectorWeight?: number;
  stalenessWeight?: number;
}

export interface DecisionPair {
  id: string;
  inBudget: boolean;
}

export interface EventReplay {
  ts: string | null;
  identical: boolean;
  windowLimited: boolean;
  orderChanged: boolean;
  entered: string[];
  left: string[];
  loggedVector: string;
  replayedVector: string;
}

export interface ReplayReport {
  replays: EventReplay[];
  skippedPreCandidates: number;
}

export interface ReplayArgs {
  eventsDir: string;
  overrides: ReplayOverrides;
}

interface LoggedCandidate {
  id: string;
  ftsRank: number | null;
  vectorRank: number | null;
  stalenessBoost: number;
  tokenEst: number | null;
  inBudget: boolean;
}

// One line per candidate in ranked order, "<id> <1|0>"; both the logged and the replayed decisions
// pass through this single serializer, so verification is a plain string comparison (D-I).
export function canonicalDecisionVector(pairs: DecisionPair[]): string {
  return pairs.map((pair) => `${pair.id} ${pair.inBudget ? 1 : 0}`).join("\n");
}

export function replayLog(events: StoredEvent[], overrides: ReplayOverrides): ReplayReport {
  refuseIfAheadOfSchema(events);
  const replays: EventReplay[] = [];
  let skippedPreCandidates = 0;
  for (const event of events) {
    if (event.type !== "recall") continue;
    const candidates = loggedCandidates(event);
    if (candidates === undefined) {
      skippedPreCandidates += 1;
      continue;
    }
    replays.push(replayRecall(event, candidates, overrides));
  }
  return { replays, skippedPreCandidates };
}

// A newer mneme could encode decisions this tool cannot reproduce; refuse the whole log up front
// rather than report a false mismatch (D-K).
function refuseIfAheadOfSchema(events: StoredEvent[]): void {
  for (const event of events) {
    if (event.schema_version > SCHEMA_VERSION) {
      throw new Error(
        `event schema_version ${event.schema_version} exceeds the supported version ${SCHEMA_VERSION}; refusing to replay`,
      );
    }
  }
}

function loggedCandidates(event: StoredEvent): LoggedCandidate[] | undefined {
  if (event.schema_version < CANDIDATES_MIN_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(event.candidates)) return undefined;
  return event.candidates.map((raw, index) => extractCandidate(raw, event.ts, index));
}

function replayRecall(
  event: StoredEvent,
  candidates: LoggedCandidate[],
  overrides: ReplayOverrides,
): EventReplay {
  const budget = overrides.budget ?? loggedBudget(event);
  const decisions = fuseAndFill(candidates.map(toFusionInput), fusionParams(overrides), budget);
  const loggedVector = canonicalDecisionVector(candidates.map((c) => ({ id: c.id, inBudget: c.inBudget })));
  const replayedVector = canonicalDecisionVector(decisions.map((d) => ({ id: d.id, inBudget: d.inBudget })));
  return {
    ts: event.ts,
    identical: loggedVector === replayedVector,
    windowLimited: isWindowLimited(event, candidates.length),
    orderChanged: orderChanged(candidates, decisions),
    entered: enteredIds(decisions, candidates),
    left: leftIds(decisions, candidates),
    loggedVector,
    replayedVector,
  };
}

function toFusionInput(candidate: LoggedCandidate): FusionInput {
  return {
    id: candidate.id,
    ftsRank: candidate.ftsRank,
    vectorRank: candidate.vectorRank,
    stalenessBoost: candidate.stalenessBoost,
    tokenEst: candidate.tokenEst,
  };
}

function fusionParams(overrides: ReplayOverrides): FusionParams {
  return {
    rrfK: overrides.rrfK ?? DEFAULT_FUSION_PARAMS.rrfK,
    ftsWeight: overrides.ftsWeight ?? DEFAULT_FUSION_PARAMS.ftsWeight,
    vectorWeight: overrides.vectorWeight ?? DEFAULT_FUSION_PARAMS.vectorWeight,
    stalenessWeight: overrides.stalenessWeight ?? DEFAULT_FUSION_PARAMS.stalenessWeight,
  };
}

function loggedBudget(event: StoredEvent): number {
  if (typeof event.budget !== "number") {
    throw new Error(`recall event at ${event.ts ?? "unknown time"} has no numeric budget`);
  }
  return event.budget;
}

// The logged list is the top-20 prefix; a larger corpus leaves ranks beyond the window unknown (D-L).
function isWindowLimited(event: StoredEvent, candidateCount: number): boolean {
  const corpusSize = typeof event.corpus_size === "number" ? event.corpus_size : 0;
  return candidateCount === RECALL_CANDIDATE_WINDOW && corpusSize > RECALL_CANDIDATE_WINDOW;
}

function orderChanged(candidates: LoggedCandidate[], decisions: FusionDecision[]): boolean {
  if (candidates.length !== decisions.length) return true;
  return candidates.some((candidate, index) => candidate.id !== decisions[index]!.id);
}

function enteredIds(decisions: FusionDecision[], candidates: LoggedCandidate[]): string[] {
  const loggedInBudget = new Set(candidates.filter((c) => c.inBudget).map((c) => c.id));
  return decisions
    .filter((d) => d.inBudget && !loggedInBudget.has(d.id))
    .map((d) => d.id)
    .sort();
}

function leftIds(decisions: FusionDecision[], candidates: LoggedCandidate[]): string[] {
  const replayedInBudget = new Set(decisions.filter((d) => d.inBudget).map((d) => d.id));
  return candidates
    .filter((c) => c.inBudget && !replayedInBudget.has(c.id))
    .map((c) => c.id)
    .sort();
}

function extractCandidate(raw: unknown, ts: string | null, index: number): LoggedCandidate {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(candidateError(ts, index, "is not an object"));
  }
  const candidate = raw as Record<string, unknown>;
  return {
    id: requireString(candidate.id, ts, index, "id"),
    ftsRank: requireNullableNumber(candidate.fts_rank, ts, index, "fts_rank"),
    vectorRank: requireNullableNumber(candidate.vector_rank, ts, index, "vector_rank"),
    stalenessBoost: requireNumber(candidate.staleness_boost, ts, index, "staleness_boost"),
    tokenEst: requireNullableNumber(candidate.token_est, ts, index, "token_est"),
    inBudget: requireBoolean(candidate.in_budget, ts, index, "in_budget"),
  };
}

function requireString(value: unknown, ts: string | null, index: number, field: string): string {
  if (typeof value !== "string") throw new Error(candidateError(ts, index, `${field} must be a string`));
  return value;
}

function requireNumber(value: unknown, ts: string | null, index: number, field: string): number {
  if (typeof value !== "number") throw new Error(candidateError(ts, index, `${field} must be a number`));
  return value;
}

function requireNullableNumber(value: unknown, ts: string | null, index: number, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(candidateError(ts, index, `${field} must be a number or null`));
  return value;
}

function requireBoolean(value: unknown, ts: string | null, index: number, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(candidateError(ts, index, `${field} must be a boolean`));
  return value;
}

function candidateError(ts: string | null, index: number, detail: string): string {
  return `recall event at ${ts ?? "unknown time"} candidate ${index} ${detail}`;
}

const FLAG_KEYS: Record<string, keyof ReplayOverrides> = {
  "--budget": "budget",
  "--rrf-k": "rrfK",
  "--fts-weight": "ftsWeight",
  "--vector-weight": "vectorWeight",
  "--staleness-weight": "stalenessWeight",
};

export function parseReplayArgs(argv: string[]): ReplayArgs {
  const overrides: ReplayOverrides = {};
  let eventsDir: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      index = consumeFlag(argv, index, overrides);
    } else if (eventsDir === undefined) {
      eventsDir = token;
      index += 1;
    } else {
      throw usageError(`unexpected argument: ${token}`);
    }
  }
  if (eventsDir === undefined) throw usageError("missing <events-dir>");
  return { eventsDir, overrides };
}

function consumeFlag(argv: string[], index: number, overrides: ReplayOverrides): number {
  const flag = argv[index]!;
  const key = FLAG_KEYS[flag];
  if (key === undefined) throw usageError(`unknown flag: ${flag}`);
  const raw = argv[index + 1];
  if (raw === undefined) throw usageError(`flag ${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw usageError(`flag ${flag} needs a finite number, got: ${raw}`);
  overrides[key] = value;
  return index + 2;
}

// Presence via !== undefined, not truthiness, so `--staleness-weight 0` still selects alternative mode.
export function hasOverrides(overrides: ReplayOverrides): boolean {
  return (
    overrides.budget !== undefined ||
    overrides.rrfK !== undefined ||
    overrides.ftsWeight !== undefined ||
    overrides.vectorWeight !== undefined ||
    overrides.stalenessWeight !== undefined
  );
}

function usageError(detail: string): Error {
  return new Error(`${detail}\n${USAGE}`);
}

export function main(argv: string[]): number {
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  let report: ReplayReport;
  try {
    report = replayLog(readEvents(args.eventsDir), args.overrides);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  if (hasOverrides(args.overrides)) {
    process.stdout.write(renderAlternative(report, args.overrides));
    return 0;
  }
  process.stdout.write(renderVerification(report));
  return report.replays.length >= 1 && report.replays.every((replay) => replay.identical) ? 0 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
