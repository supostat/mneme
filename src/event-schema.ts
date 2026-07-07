import { z } from "zod";

// The runtime-validatable contract for every event the write path produces. It validates PRODUCERS
// only; readEvents stays deliberately tolerant and is NEVER gated on this schema.
//
// Schema version history (schema_version stamped on every event):
//   0 — pre-stamp events: no envelope at all; readEvents backfills a null envelope + schema_version 0.
//   1 — envelope introduced: session_id, ts, mneme_version, schema_version on every event.
//   2 — enriched write path: note_staged -> remember (carries dedup detail, body_len, anchors_n,
//       source); note_accepted / note_rejected / note_superseded -> staging_resolve (one decision-
//       tagged event); note_deduped -> remember{dedup.outcome:"noop"}; new rebuild, session_start,
//       session_end and sanitized tool_error events.
//   3 — recall enriched: mode, corpus_size, timings{embed_ms, fts_ms, fusion_ms}, candidates[<=20,
//       fused order, pre-budget-cutoff]{id, type, fts_rank, vector_rank, cosine, rrf, staleness_boost,
//       token_est, in_budget}. Other events unchanged.
export const SCHEMA_VERSION = 3;

export const DEDUP_OUTCOMES = ["add", "supersede_suggest", "noop"] as const;
export const RESOLVE_DECISIONS = ["accept", "reject", "supersede"] as const;
export const ANCHOR_LIVENESS = ["tracked", "untracked-exists", "missing"] as const;
export const RECALL_MODES = ["fused", "fts_only", "vector_only", "none"] as const;
export const RECALL_CANDIDATE_WINDOW = 20;

// The five schema-v1 event names and the enriched v2 event that now subsumes each. A replay or
// backfill reads a legacy name through this map; the reader itself never rewrites the log.
export const BOOTSTRAP_TO_EXTENDED = {
  note_staged: "remember",
  note_deduped: "remember",
  note_accepted: "staging_resolve",
  note_rejected: "staging_resolve",
  note_superseded: "staging_resolve",
} as const;

const envelope = {
  session_id: z.string(),
  ts: z.string(),
  mneme_version: z.string(),
  schema_version: z.literal(SCHEMA_VERSION),
};

const dedupOutcome = z.object({
  outcome: z.enum(DEDUP_OUTCOMES),
  nearest_id: z.string().nullable(),
  similarity: z.number().nullable(),
  supersede_threshold: z.number(),
  noop_threshold: z.number(),
  degraded: z.boolean(),
});

const anchorLiveness = z.object({
  path: z.string(),
  liveness: z.enum(ANCHOR_LIVENESS),
});

// One pre-budget-cutoff candidate in fused order. type/fts_rank/vector_rank/cosine/token_est are
// nullable: a candidate reached by only one channel has no rank in the other, a body absent from the
// index cannot be token-estimated, and a note may carry no type.
const recallCandidate = z.object({
  id: z.string(),
  type: z.string().nullable(),
  fts_rank: z.number().nullable(),
  vector_rank: z.number().nullable(),
  cosine: z.number().nullable(),
  rrf: z.number(),
  staleness_boost: z.number(),
  token_est: z.number().nullable(),
  in_budget: z.boolean(),
});

const recallEvent = z.object({
  type: z.literal("recall"),
  ...envelope,
  query: z.string(),
  budget: z.number(),
  returned_ids: z.array(z.string()),
  degraded: z.boolean(),
  mode: z.enum(RECALL_MODES),
  corpus_size: z.number(),
  timings: z.object({
    embed_ms: z.number(),
    fts_ms: z.number(),
    fusion_ms: z.number(),
  }),
  candidates: z.array(recallCandidate).max(RECALL_CANDIDATE_WINDOW),
});

const rememberEvent = z.object({
  type: z.literal("remember"),
  ...envelope,
  note_id: z.string(),
  note_type: z.string(),
  body_len: z.number(),
  anchors_n: z.number(),
  source: z.string(),
  dedup: dedupOutcome,
});

// Decision-polymorphic: commit/superseded_id/suggested are nullable so a reject (no commit, no
// target) validates against the same shape a supersede fills in completely.
const stagingResolveEvent = z.object({
  type: z.literal("staging_resolve"),
  ...envelope,
  note_id: z.string(),
  decision: z.enum(RESOLVE_DECISIONS),
  staged_to_resolved_ms: z.number().nullable(),
  commit: z.string().nullable(),
  superseded_id: z.string().nullable(),
  suggested: z.boolean().nullable(),
});

const stagingListedEvent = z.object({
  type: z.literal("staging_listed"),
  ...envelope,
  count: z.number(),
  liveness: z.array(z.object({ id: z.string(), anchors: z.array(anchorLiveness) })),
});

const rebuildEvent = z.object({
  type: z.literal("rebuild"),
  ...envelope,
  duration_ms: z.number(),
  notes_n: z.number(),
  embedded_n: z.number(),
  dead_anchors_n: z.number(),
  staleness: z.array(z.number()),
  ollama: z.object({ available: z.boolean(), retries: z.number() }),
});

// session_start / session_end carry only the envelope. An ABSENT session_end means the session was
// cut off (SIGKILL, kernel panic, killed terminal) — that is normal, NOT a data error; Phase-6
// duration analysis pairs each session_start with its session_end and treats a missing end as open.
const sessionStartEvent = z.object({ type: z.literal("session_start"), ...envelope });
const sessionEndEvent = z.object({ type: z.literal("session_end"), ...envelope });

const toolErrorEvent = z.object({
  type: z.literal("tool_error"),
  ...envelope,
  tool: z.string(),
  message: z.string(),
});

export const eventSchema = z.discriminatedUnion("type", [
  recallEvent,
  rememberEvent,
  stagingResolveEvent,
  stagingListedEvent,
  rebuildEvent,
  sessionStartEvent,
  sessionEndEvent,
  toolErrorEvent,
]);
