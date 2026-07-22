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
//   4 — workflow surface: workflow_run_started (full run definition + retrieval config),
//       workflow_step_applied (reducer fold step, optional gate report / harvest count) and
//       workflow_run_marked_stale; every workflow payload names its branch. RESTORE-COMPATIBILITY
//       RULE: run restore parses with the *Restore schema variants, whose envelope accepts any
//       integer schema_version >= 4, so a future version bump never renders live runs unreadable —
//       a bump may EXTEND the workflow payloads but must never repurpose an existing field.
//   5 — recall origin: the recall event names WHO issued it — workflow-step (the engine's memory
//       step) vs tool-call (a manual recall through MCP). Older recall events carry no origin; a
//       reader treats its absence as "unknown" (the same backfill discipline as the v0 pre-stamp
//       envelope), never a hard failure.
//   6 — gate votes: each agent-judged criterion in workflow_step_applied gates.criteria[] carries its
//       votes [{vote, remarks}] (null for executable criteria); remarks of fail votes are replayed
//       into the retry attempt's execute_step directive. Older gates events carry no votes key — the
//       restore fold reads absence as "no votes recorded" (the v4 extend-never-repurpose rule).
//   7 — harvest dedup visibility: a harvest workflow_step_applied names what dedup silently dropped —
//       dedup_rejected [{nearest_id, similarity}] (null for non-harvest applications), and
//       harvested_n counts notes actually STAGED, no longer every submitted artifact. Telemetry
//       payload: the log is richer than its current readers, per the deliberate exception.
//   8 — run abandonment: workflow_run_abandoned { run_id, branch, reason } is a human's terminal
//       refusal of a run — distinct from failure. Restore honors the marker on the raw run_id (the
//       stale-marker discipline) and the survey excludes abandoned runs from every live listing.
//   9 — curation: note_retire_staged {request_id, target_id, reason} queues a retire decision for
//       the human gate; note_retire_resolved {request_id, target_id, decision, commit} applies it.
//       An accepted retire rewrites the note's frontmatter (retired: true) — the file stays in
//       notes/ as history and the index keeps deriving from notes/ alone.
export const SCHEMA_VERSION = 9;

export const DEDUP_OUTCOMES = ["add", "supersede_suggest", "noop"] as const;
export const RESOLVE_DECISIONS = ["accept", "reject", "supersede"] as const;
export const RETIRE_DECISIONS = ["accept", "reject"] as const;
export const ANCHOR_LIVENESS = ["tracked", "untracked-exists", "missing"] as const;
export const RECALL_MODES = ["fused", "fts_only", "vector_only", "none"] as const;
export const RECALL_CANDIDATE_WINDOW = 20;

// Who issued a recall: the engine's memory step or a manual tool call. recall() takes this as a
// required argument, so the compiler forces every caller to name its origin — a third caller cannot
// be added without extending this enum. There are exactly two callers today (verified by grep).
export const RECALL_ORIGINS = ["workflow-step", "tool-call"] as const;
export type RecallOrigin = (typeof RECALL_ORIGINS)[number];

// A recall event stamped before schema v5 carries no origin; every reader maps that absence to this
// value rather than dropping or failing on the event.
export const RECALL_ORIGIN_UNKNOWN = "unknown";

// Mirrors converge's Vote union; the bidirectional pin lives in event-schema.test.ts so this
// registry never imports from src/workflow.
export const AGENT_VOTE_VALUES = ["pass", "fail"] as const;
export const WORKFLOW_RESULT_KINDS = ["recall", "execute_step", "harvest"] as const;
export const WORKFLOW_STEP_OUTCOMES = ["success", "failure"] as const;
export const WORKFLOW_ON_FAIL_ACTIONS = ["rewind", "skip", "escalate"] as const;
export const WORKFLOW_STALE_REASONS = ["branch_not_found"] as const;
export const DONE_WHEN_KINDS = ["executable", "agent-judged"] as const;
// Mirrors gate-runner's ExecutableGateReason union; the bidirectional pin lives in event-schema.test.ts
// so this registry never imports from src/workflow.
export const EXECUTABLE_GATE_REASONS = [
  "exit-zero",
  "exit-nonzero",
  "timeout",
  "spawn-error",
  "malformed-command",
] as const;

// The schema version that introduced the workflow events; the restore envelope floor is pinned to it
// (NOT to SCHEMA_VERSION) so events stamped by any past-or-future >=4 producer stay restorable.
const WORKFLOW_EVENTS_MIN_SCHEMA_VERSION = 4;

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
  origin: z.enum(RECALL_ORIGINS),
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

const noteRetireStagedEvent = z.object({
  type: z.literal("note_retire_staged"),
  ...envelope,
  request_id: z.string(),
  target_id: z.string(),
  reason: z.string(),
});

// commit is null for a rejected retire (nothing was written to the corpus repo).
const noteRetireResolvedEvent = z.object({
  type: z.literal("note_retire_resolved"),
  ...envelope,
  request_id: z.string(),
  target_id: z.string(),
  decision: z.enum(RETIRE_DECISIONS),
  commit: z.string().nullable(),
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

// The version-tolerant envelope for RESTORING workflow runs (see the v4 changelog rule). Producers
// never use it: live writes validate against the strict envelope above.
const restoreEnvelope = {
  session_id: z.string(),
  ts: z.string(),
  mneme_version: z.string(),
  schema_version: z.number().int().min(WORKFLOW_EVENTS_MIN_SCHEMA_VERSION),
};

// command is null for agent-judged criteria; both criterion kinds share one payload shape.
const doneWhenCriterion = z.object({
  kind: z.enum(DONE_WHEN_KINDS),
  description: z.string(),
  command: z.string().nullable(),
});

const runPhase = z.object({
  id: z.string(),
  deps: z.array(z.string()),
  agent_role: z.string(),
  description: z.string(),
  tasks: z.array(z.string()),
  done_when: z.array(doneWhenCriterion),
});

const runStep = z.object({
  id: z.string(),
  max_attempts: z.number().int(),
  on_fail: z.object({ action: z.enum(WORKFLOW_ON_FAIL_ACTIONS), to: z.string().nullable() }),
});

const runDefinitionPayload = z.object({
  phases: z.array(runPhase),
  steps: z.array(runStep),
  max_iterations: z.number().int(),
  recall_budget: z.number().int(),
  recall_anchors: z.record(z.string(), z.array(z.string())),
});

const gateVotePayload = z.object({
  vote: z.enum(AGENT_VOTE_VALUES),
  remarks: z.string().nullable(),
});

// votes is null for executable criteria and OPTIONAL in the shape: pre-v6 gates events carry no
// votes key at all, and the restore envelope must keep parsing them (the v4 extend rule).
const gateCriterionPayload = z.object({
  kind: z.enum(DONE_WHEN_KINDS),
  description: z.string(),
  passed: z.boolean(),
  reason: z.enum(EXECUTABLE_GATE_REASONS).nullable(),
  votes: z.array(gateVotePayload).nullable().optional(),
});

const workflowRunStartedPayload = {
  run_id: z.string(),
  branch: z.string(),
  definition: runDefinitionPayload,
};

// step_id/outcome/attempt are null for recall and harvest applications; gates is non-null only for a
// gated final-step application; harvested_n is non-null only for a harvest application.
const workflowStepAppliedPayload = {
  run_id: z.string(),
  branch: z.string(),
  phase_id: z.string(),
  result_kind: z.enum(WORKFLOW_RESULT_KINDS),
  step_id: z.string().nullable(),
  outcome: z.enum(WORKFLOW_STEP_OUTCOMES).nullable(),
  attempt: z.number().int().nullable(),
  gates: z
    .object({
      passed: z.boolean(),
      executable_n: z.number().int(),
      agent_judged_n: z.number().int(),
      criteria: z.array(gateCriterionPayload),
    })
    .nullable(),
  harvested_n: z.number().int().nullable(),
  // Null for non-harvest applications and OPTIONAL in the shape: pre-v7 harvest events carry no
  // dedup_rejected key, and the restore envelope must keep parsing them (the v4 extend rule).
  dedup_rejected: z
    .array(z.object({ nearest_id: z.string(), similarity: z.number() }))
    .nullable()
    .optional(),
};

const workflowRunMarkedStalePayload = {
  run_id: z.string(),
  branch: z.string(),
  reason: z.enum(WORKFLOW_STALE_REASONS),
};

// reason is the human's free-text refusal, validated to a single clean line at the tool boundary.
const workflowRunAbandonedPayload = {
  run_id: z.string(),
  branch: z.string(),
  reason: z.string(),
};

export const workflowRunStartedEvent = z.object({
  type: z.literal("workflow_run_started"),
  ...envelope,
  ...workflowRunStartedPayload,
});

export const workflowStepAppliedEvent = z.object({
  type: z.literal("workflow_step_applied"),
  ...envelope,
  ...workflowStepAppliedPayload,
});

export const workflowRunMarkedStaleEvent = z.object({
  type: z.literal("workflow_run_marked_stale"),
  ...envelope,
  ...workflowRunMarkedStalePayload,
});

export const workflowRunAbandonedEvent = z.object({
  type: z.literal("workflow_run_abandoned"),
  ...envelope,
  ...workflowRunAbandonedPayload,
});

export const workflowRunStartedRestore = z.object({
  type: z.literal("workflow_run_started"),
  ...restoreEnvelope,
  ...workflowRunStartedPayload,
});

export const workflowStepAppliedRestore = z.object({
  type: z.literal("workflow_step_applied"),
  ...restoreEnvelope,
  ...workflowStepAppliedPayload,
});

export const workflowRunMarkedStaleRestore = z.object({
  type: z.literal("workflow_run_marked_stale"),
  ...restoreEnvelope,
  ...workflowRunMarkedStalePayload,
});

export const workflowRunAbandonedRestore = z.object({
  type: z.literal("workflow_run_abandoned"),
  ...restoreEnvelope,
  ...workflowRunAbandonedPayload,
});

export const eventSchema = z.discriminatedUnion("type", [
  recallEvent,
  rememberEvent,
  stagingResolveEvent,
  stagingListedEvent,
  noteRetireStagedEvent,
  noteRetireResolvedEvent,
  rebuildEvent,
  sessionStartEvent,
  sessionEndEvent,
  toolErrorEvent,
  workflowRunStartedEvent,
  workflowStepAppliedEvent,
  workflowRunMarkedStaleEvent,
  workflowRunAbandonedEvent,
]);
