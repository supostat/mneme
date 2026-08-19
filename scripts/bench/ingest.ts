#!/usr/bin/env bun
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json";
import { defaultConfig } from "../../src/config";
import type { MnemeConfig } from "../../src/config";
import { resolveCorpus } from "../../src/corpus";
import type { EmbeddingsClient } from "../../src/embeddings";
import { EventWriter } from "../../src/events";
import { MAX_BODY_CODE_POINTS } from "../../src/note";
import { ForbiddenMarkupError } from "../../src/sanitize-body";
import { remember, stagingResolve } from "../../src/staging";
import type { StagingDeps } from "../../src/staging";
import type { RememberResult } from "../../src/staging";
import type { BenchCase, BenchQuestion, BenchSession } from "./normalize";

// Builds one isolated benchmark corpus per case through the engine's own write path
// (remember + stagingResolve), acting as the scripted auto-curator the methodology
// declares: every staged note is resolved programmatically, so the human gate is the
// one mneme mechanism this harness deliberately switches off.
//
// A session becomes one or more notes: the engine caps a note body at
// MAX_BODY_CODE_POINTS, so longer sessions are chunked MECHANICALLY (line-boundary
// windows, no semantic fact extraction) and a question's evidence stays at SESSION
// level — a retrieval hit on any chunk is a hit on the session. Dedup is disabled via
// config thresholds (1/1): the corpus must mirror the haystack one-to-one, and the
// dedup gate belongs to the disabled curator, not to the measured retrieval layer.

export class IngestError extends Error {}

export type IngestMode = "coexist" | "supersede";

export interface IngestDeps {
  projectRoot: string;
  corpusHome: string;
  embeddings: EmbeddingsClient;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface IngestedSession {
  sessionId: string;
  noteIds: string[];
  supersededNoteIds: string[];
}

export interface IngestedCase {
  caseId: string;
  mode: IngestMode;
  corpusDir: string;
  eventsDir: string;
  indexPath: string;
  sessions: IngestedSession[];
}

export function benchCorpusHome(): string {
  return mkdtempSync(join(tmpdir(), "mneme-bench-"));
}

// Dedup thresholds pinned to 1: similarity never reaches them, so no haystack session
// is silently dropped or offered as a supersede by the engine's dedup gate.
function benchConfig(): MnemeConfig {
  const config = defaultConfig();
  config.dedup = { supersedeThreshold: 1, noopThreshold: 1 };
  return config;
}

export async function ingestCase(benchCase: BenchCase, mode: IngestMode, deps: IngestDeps): Promise<IngestedCase> {
  const clock = deps.clock ?? (() => new Date());
  const idFactory = deps.idFactory ?? (() => crypto.randomUUID());
  await assertEmbedderAvailable(deps.embeddings);
  const corpus = await resolveCorpus(deps.projectRoot, { corpusHome: deps.corpusHome, clock });
  const stagingDeps: StagingDeps = {
    corpus,
    projectRoot: deps.projectRoot,
    config: benchConfig(),
    clock,
    idFactory,
    embeddings: deps.embeddings,
    eventWriter: new EventWriter(corpus.eventsDir, {
      sessionId: idFactory(),
      clock,
      mnemeVersion: packageJson.version,
    }),
  };
  const predecessorBySessionId = mode === "supersede" ? updatePredecessors(benchCase.questions) : new Map<string, string>();
  const chunkCounts = chainChunkCounts(benchCase, predecessorBySessionId);
  const ingestedBySessionId = new Map<string, IngestedSession>();
  const sessions: IngestedSession[] = [];
  for (const session of benchCase.sessions) {
    const predecessorId = predecessorBySessionId.get(session.id);
    const predecessor = predecessorId === undefined ? undefined : ingestedBySessionId.get(predecessorId);
    if (predecessorId !== undefined && predecessor === undefined) {
      throw new IngestError(
        `case ${benchCase.id}: update session ${session.id} precedes its predecessor ${predecessorId} in haystack order`,
      );
    }
    const ingested = await ingestSession(stagingDeps, session, chunkCounts.get(session.id) ?? 1, predecessor);
    ingestedBySessionId.set(session.id, ingested);
    sessions.push(ingested);
  }
  return {
    caseId: benchCase.id,
    mode,
    corpusDir: corpus.corpusDir,
    eventsDir: corpus.eventsDir,
    indexPath: corpus.indexPath,
    sessions,
  };
}

async function assertEmbedderAvailable(embeddings: EmbeddingsClient): Promise<void> {
  const probe = await embeddings.embed(["bench embedder probe"]);
  if (!probe.available) {
    throw new IngestError(
      "embedder is unavailable - the benchmark refuses to build a vector-less (degraded) corpus; " +
        "start the configured embedding endpoint and rerun",
    );
  }
}

// Knowledge-update evidence chains, dataset-labeled: within a chain each later session
// supersedes its immediate predecessor, so the chain's last session is the only one
// left active. Detection never falls back to heuristics — no label, no supersede.
function updatePredecessors(questions: BenchQuestion[]): Map<string, string> {
  const predecessorBySessionId = new Map<string, string>();
  for (const question of questions) {
    if (question.category !== "knowledge-update") continue;
    for (let index = 1; index < question.evidenceSessionIds.length; index += 1) {
      predecessorBySessionId.set(question.evidenceSessionIds[index]!, question.evidenceSessionIds[index - 1]!);
    }
  }
  return predecessorBySessionId;
}

// Sessions of one update chain are chunked to the SAME count (the chain's maximum), so
// supersede pairs chunks one-to-one and no stale chunk of the older session survives.
function chainChunkCounts(benchCase: BenchCase, predecessorBySessionId: Map<string, string>): Map<string, number> {
  const naturalCounts = new Map<string, number>();
  for (const session of benchCase.sessions) {
    naturalCounts.set(session.id, chunkSessionText(session.text).length);
  }
  const chainOf = new Map<string, string[]>();
  for (const [successor, predecessor] of predecessorBySessionId) {
    const chain = chainOf.get(predecessor) ?? [predecessor];
    chain.push(successor);
    chainOf.set(successor, chain);
  }
  const counts = new Map(naturalCounts);
  for (const chain of new Set(chainOf.values())) {
    const maximum = Math.max(...chain.map((sessionId) => naturalCounts.get(sessionId) ?? 1));
    for (const sessionId of chain) {
      counts.set(sessionId, maximum);
    }
  }
  return counts;
}

async function ingestSession(
  stagingDeps: StagingDeps,
  session: BenchSession,
  chunkCount: number,
  predecessor: IngestedSession | undefined,
): Promise<IngestedSession> {
  const chunks = chunkSessionText(session.text, chunkCount);
  const tags = sessionTags(session);
  const noteIds: string[] = [];
  const supersededNoteIds: string[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const result = await rememberChunk(stagingDeps, session, chunk, tags);
    if (result.outcome === "noop") {
      noteIds.push(result.existingId);
      continue;
    }
    if (result.degraded) {
      throw new IngestError(`session ${session.id}: embedder degraded mid-ingest; corpus would be partial`);
    }
    if (predecessor === undefined) {
      await stagingResolve(stagingDeps, result.noteId, "accept");
    } else {
      const target = predecessor.noteIds[chunkIndex];
      if (target === undefined) {
        throw new IngestError(
          `session ${session.id}: chunk ${chunkIndex} has no predecessor note to supersede (chain chunking drifted)`,
        );
      }
      await stagingResolve(stagingDeps, result.noteId, { supersede: target });
      supersededNoteIds.push(target);
    }
    noteIds.push(result.noteId);
  }
  return { sessionId: session.id, noteIds, supersededNoteIds };
}

// The engine's own gate stays the authoritative backstop: a forbidden pattern the defang
// list misses still fails closed, with the session named so the list can be extended.
async function rememberChunk(
  stagingDeps: StagingDeps,
  session: BenchSession,
  chunk: string,
  tags: string[],
): Promise<RememberResult> {
  try {
    return await remember(stagingDeps, { type: "pattern", body: chunk, anchors: [], tags, source: "bench-ingest" });
  } catch (error) {
    if (error instanceof ForbiddenMarkupError) {
      throw new IngestError(
        `session ${session.id}: engine rejected the body (${error.message}); extend defangForbiddenMarkup`,
      );
    }
    throw error;
  }
}

// Tags carry the dataset's own markup (speakers, dates); a session with no marked
// entities falls back to its id — a note with empty anchors must carry at least one tag.
function sessionTags(session: BenchSession): string[] {
  const entities = [...new Set(session.entities)].filter((entity) => entity.length > 0);
  return entities.length > 0 ? entities : [session.id];
}

// The engine's write path fail-closed rejects foreign tool/protocol markup in a note body
// (assertCleanNoteBody), and real conversational datasets DO carry such fragments ("<html"
// inside LongMemEval sessions). A human curator would rephrase; the scripted curator defangs
// MECHANICALLY instead: the opening bracket of exactly the engine-forbidden tag patterns
// becomes U+2039, the note-fence literals gain the same mark between words, and the
// framing-breaking code points map to plain newlines — lexical tokens survive for FTS.
const DEFANGED_BRACKET = "‹";
const FORBIDDEN_TAG_PATTERN =
  /<(\/?)(function_calls|invoke|parameter|function_results|system-reminder|html|head|body)\b/gi;
const FORBIDDEN_FENCE_PATTERN = /(BEGIN|END) MNEME NOTE/gi;

export function defangForbiddenMarkup(text: string): string {
  return text
    .replace(FORBIDDEN_TAG_PATTERN, `${DEFANGED_BRACKET}$1$2`)
    .replace(FORBIDDEN_FENCE_PATTERN, `$1${DEFANGED_BRACKET}MNEME${DEFANGED_BRACKET}NOTE`)
    .replace(/[\u2028\u2029\u0085]/g, "\n");
}

// Mechanical chunking: split on line boundaries into windows of at most
// MAX_BODY_CODE_POINTS code points; minChunks forces extra splits so update-chain
// sessions align chunk-for-chunk. Lines longer than the limit hard-split by code point.
export function chunkSessionText(text: string, minChunks = 1, limit = MAX_BODY_CODE_POINTS): string[] {
  const normalized = defangForbiddenMarkup(text).replace(/\r\n?/g, "\n").replace(/^\n+/, "");
  if ([...normalized].length === 0) {
    throw new IngestError("session text is empty after normalization; it cannot become a note body");
  }
  let chunks = splitByLines(normalized, limit);
  while (chunks.length < minChunks) {
    const widest = chunks.reduce((left, right) => ([...left].length >= [...right].length ? left : right));
    if ([...widest].length < 2) break;
    const halves = splitInHalf(widest);
    chunks = chunks.flatMap((chunk) => (chunk === widest ? halves : [chunk]));
  }
  return chunks;
}

function splitByLines(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  const flush = (): void => {
    const chunk = current.join("\n").replace(/^\n+/, "");
    if ([...chunk].length > 0) chunks.push(chunk);
    current = [];
    currentLength = 0;
  };
  for (const line of text.split("\n")) {
    const pieces = [...line].length > limit ? hardSplit(line, limit) : [line];
    for (const piece of pieces) {
      const pieceLength = [...piece].length;
      if (currentLength > 0 && currentLength + 1 + pieceLength > limit) flush();
      current.push(piece);
      currentLength += (currentLength > 0 ? 1 : 0) + pieceLength;
    }
  }
  flush();
  return chunks;
}

function hardSplit(line: string, limit: number): string[] {
  const codePoints = [...line];
  const pieces: string[] = [];
  for (let start = 0; start < codePoints.length; start += limit) {
    pieces.push(codePoints.slice(start, start + limit).join(""));
  }
  return pieces;
}

function splitInHalf(chunk: string): string[] {
  const codePoints = [...chunk];
  const middle = Math.ceil(codePoints.length / 2);
  return [codePoints.slice(0, middle).join(""), codePoints.slice(middle).join("")].map((half) =>
    half.replace(/^\n+/, ""),
  );
}
