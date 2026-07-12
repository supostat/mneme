# Mneme proof metrics

The `stats` MCP tool reports proof metrics about the corpus **from the event log
alone** — no note bodies, no LLM, no index: the three proof questions below, two corpus
signals (live corpus size by type, and NOOP write-path confirmations), review-friction signals
(staged->resolved latency, review batch sizes, and per-tool errors), and the log footprint. This
document states each, how the `stats` tool computes it, and a hand-reproducible `jq` recipe you
can run yourself.

`jq` is used here for **hand-verification only**. It is **not** a runtime dependency of
mneme; the tool computes every number in `src/stats.ts`, `src/stats-friction.ts` and
`src/stats-footprint.ts`.

## Where the event log lives

The log is **outside the project tree**, per machine, under the corpus home. For a project
whose canonical (real) root is `/Users/you/Projects/mneme`, the events directory is:

```
~/.mneme/-Users-you-Projects-mneme/events/*.jsonl
```

The path segment is the **canonical project root with every `/` replaced by `-`** (the
`mungePath` transform). Resolve your own segment with:

```sh
echo "$(realpath .)" | sed 's#/#-#g'
```

Then set a shell variable used by every recipe below (adjust to your munged segment):

```sh
EVENTS=~/.mneme/-Users-you-Projects-mneme/events
```

Events are newline-delimited JSON split across monthly files (`YYYY-MM.jsonl`). Every recipe
concatenates them and slurps with `jq -s`.

## The accepted population (historical)

Every metric is anchored to the **accepted population**: the distinct `note_id` of a resolution
that kept the note. In schema v1 that is a `note_accepted` event; in schema v2 it is a
`staging_resolve` whose `decision` is `accept` **or** `supersede` (a supersede accepts a new note
while retiring an old one). Every recipe below unions both dialects, so a log spanning the migration
counts identically. This population is **historical** — it includes notes later superseded. Rejected
notes are outside it; NOOP dedups are outside it (v1 `note_deduped` / v2 `remember` with
`dedup.outcome == "noop"`).

```sh
cat "$EVENTS"/*.jsonl | jq -s '[.[] | select(.type=="note_accepted" or (.type=="staging_resolve" and (.decision=="accept" or .decision=="supersede"))) | .note_id] | unique'
```

The **superseded ids** — the set to subtract from the accepted population to get the *live*
corpus — union the v1 `note_superseded.superseded_id` with the v2
`staging_resolve{decision=="supersede"}.superseded_id`:

```sh
cat "$EVENTS"/*.jsonl | jq -s '([.[] | select(.type=="note_superseded") | .superseded_id] + [.[] | select(.type=="staging_resolve" and .decision=="supersede") | .superseded_id]) | unique'
```

`liveAccepted` is then the accepted population minus these ids; the corpus-size recipe below
computes the full difference (`$accepted - $superseded`).

## (a) Are accepted notes reused across sessions?

**Definition.** Denominator = the whole accepted population (the dual-dialect union defined above).
Numerator = accepted notes whose id appears in some `recall.returned_ids` in a session
**different from the note's creation (staging) session**, at a timestamp strictly later than the
staging timestamp. The anchor is the note's **`note_staged`** event (earliest wins), *not* its
acceptance: a note staged in `S1`, accepted in `S2`, and recalled in `S2` crossed a session
boundary at creation and must count. A note reused *before* it was superseded still counts. An
accepted note with no staging anchor cannot be ordered and is not counted. The staging anchor is the
note's `note_staged` (v1) or its `remember` with `dedup.outcome != "noop"` (v2) — a noop never
staged a note, so it is excluded.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  ([.[] | select(.type=="note_accepted" or (.type=="staging_resolve" and (.decision=="accept" or .decision=="supersede"))) | .note_id] | unique) as $accepted
  | (reduce (.[] | select(.type=="note_staged" or (.type=="remember" and .dedup.outcome!="noop"))) as $e ({};
       .[$e.note_id] as $prev
       | if $prev == null or ($e.ts < $prev.ts)
         then .[$e.note_id] = {session: $e.session_id, ts: $e.ts} else . end)) as $staged
  | [.[] | select(.type=="recall")] as $recalls
  | ([ $accepted[] as $id
       | $staged[$id] as $a
       | select($a != null and $a.session != null and $a.ts != null)
       | select(any($recalls[];
           ((.returned_ids // []) | index($id)) != null
           and .session_id != null and .ts != null
           and .session_id != $a.session
           and .ts > $a.ts)) ] | length) as $numerator
  | {numerator: $numerator, denominator: ($accepted | length)}'
```

## (b) What fraction of accepted notes is never retrieved?

**Definition.** Denominator = the whole accepted population. Numerator = accepted notes never
present in any `recall.returned_ids`. The `stats` tool additionally reports how many of those
never-retrieved notes are superseded, so *dead weight* (accepted, never used, still live) is
distinguished from *lived-updated-not-lifted* (superseded).

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  ([.[] | select(.type=="note_accepted" or (.type=="staging_resolve" and (.decision=="accept" or .decision=="supersede"))) | .note_id] | unique) as $accepted
  | ([.[] | select(.type=="recall") | (.returned_ids // [])[]] | unique) as $retrieved
  | (([.[] | select(.type=="note_superseded") | .superseded_id] + [.[] | select(.type=="staging_resolve" and .decision=="supersede") | .superseded_id]) | unique) as $superseded
  | ([$accepted[] as $id | select(($retrieved | index($id)) == null) | $id]) as $never
  | {numerator: ($never | length),
     denominator: ($accepted | length),
     ofWhichSuperseded: ([$never[] as $id | select(($superseded | index($id)) != null) | $id] | length)}'
```

## (c) How often does recall report degradation?

**Definition.** `recall.degraded === true` over the total number of `recall` events.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  ([.[] | select(.type=="recall")]) as $recalls
  | {numerator: ([$recalls[] | select(.degraded == true)] | length),
     denominator: ($recalls | length)}'
```

## Corpus size by type (live)

Live accepted notes joined to the `note_type` of their staging event (`note_staged` or non-noop
`remember`); unmatched notes fall into the
`untyped` bucket. Computed over `liveAccepted`, not the historical population.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  ([.[] | select(.type=="note_accepted" or (.type=="staging_resolve" and (.decision=="accept" or .decision=="supersede"))) | .note_id] | unique) as $accepted
  | (([.[] | select(.type=="note_superseded") | .superseded_id] + [.[] | select(.type=="staging_resolve" and .decision=="supersede") | .superseded_id]) | unique) as $superseded
  | ([$accepted[] as $id | select(($superseded | index($id)) == null) | $id]) as $live
  | (reduce (.[] | select(.type=="note_staged" or (.type=="remember" and .dedup.outcome!="noop"))) as $e ({};
       if .[$e.note_id] == null then .[$e.note_id] = $e.note_type else . end)) as $types
  | reduce $live[] as $id ({}; ($types[$id] // "untyped") as $t | .[$t] += 1)'
```

## NOOP confirmations

A separate value signal: write-path re-encounters of knowledge the corpus already holds. A NOOP is a
v1 `note_deduped` event or a v2 `remember` whose `dedup.outcome == "noop"`. Not part of (a)/(b).

```sh
cat "$EVENTS"/*.jsonl | jq -s '([.[] | select(.type=="note_deduped")] + [.[] | select(.type=="remember" and .dedup.outcome=="noop")]) | length'
```

Alongside the event count, the `stats` tool reports the count of **distinct re-confirmed notes** —
the v1 `note_deduped.existing_id` unioned with the v2 `remember{dedup.outcome=="noop"}.dedup.nearest_id`.
Ten encounters of one note and ten notes seen once each both yield a count of 10, but the first is one
note re-confirmed ten times and the second is ten notes each re-confirmed once: different corpus
stories.

```sh
cat "$EVENTS"/*.jsonl | jq -s '([.[] | select(.type=="note_deduped") | .existing_id] + [.[] | select(.type=="remember" and .dedup.outcome=="noop") | .dedup.nearest_id]) | unique | length'
```

## (d) How long do staged notes wait before a human resolves them?

**Definition.** For each resolution — v1 `note_accepted` / `note_rejected` / `note_superseded` or v2
`staging_resolve` of any decision — the staged-to-resolved latency. A note re-resolved by a replay
(an accept/supersede replay re-emits `staging_resolve` with a *recomputed, inflated* latency) is
**collapsed to its earliest resolution first** so no note is counted twice, then the median and p90 are
reported by nearest-rank (1-based `ceil(p*n)`). In v2 the latency is logged directly as
`staged_to_resolved_ms`; a v1 resolution derives it from the interval between its own `ts` and its
note's **earliest staging anchor** (`note_staged`, or a non-noop `remember`), counted only when both
timestamps parse and the interval is non-negative. A v1 resolution with no staging anchor contributes
to the batch clustering below but cannot be timed.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  def secs: sub("\\.[0-9]+Z$";"Z") | fromdateiso8601;                     # ISO ms -> epoch seconds
  (reduce (.[] | select(.type=="note_staged" or (.type=="remember" and .dedup.outcome!="noop"))) as $e ({};
     .[$e.note_id] as $prev | if $prev == null or ($e.ts < $prev) then .[$e.note_id] = $e.ts else . end)) as $staged
  | [.[] | select(.type=="note_accepted" or .type=="note_rejected" or .type=="note_superseded" or .type=="staging_resolve")]
  | group_by(.note_id) | map(min_by(.ts))                                 # D-D: earliest resolve per note
  | map(if (.staged_to_resolved_ms | type) == "number"                    # D-E: v2 logs the latency
          then .staged_to_resolved_ms
          else ($staged[.note_id] as $s | if ($s != null and .ts != null) # v1: derive from the anchor
                  then ((.ts | secs) - ($s | secs)) * 1000 else null end) end)
  | map(select(. != null and . >= 0)) | sort as $d
  | {count: ($d|length),
     median: (if ($d|length)==0 then null else $d[((($d|length)*0.5|ceil)-1)] end),
     p90:    (if ($d|length)==0 then null else $d[((($d|length)*0.9|ceil)-1)] end)}'
```

`fromdateiso8601` cannot parse the millisecond fraction mneme stamps, so `secs` strips it first.
`min_by(.ts)` is a hand-verification shortcut; the `stats` tool additionally drops a null-timestamp
duplicate outright rather than letting it win the collapse.

## (e) How are resolutions batched into review sittings?

**Definition.** Resolutions in **one session** whose successive timestamps stay within
`RESOLVE_BATCH_GAP_MS` (**300000 ms**, five minutes) form one batch; a gap **strictly greater** than
the constant starts a new batch (a gap exactly equal stays in the batch). Cross-dialect: v1 and v2
resolutions cluster together (they are ordered by `ts`, then `note_id`). Resolutions with a null
`session_id` or null `ts` cannot be placed on a timeline and are excluded. The tool reports the
distribution of batch sizes. Duplicates are collapsed (D-D) before clustering, so a replay never
inflates a batch.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  def ms: sub("\\.[0-9]+Z$";"Z") | fromdateiso8601 * 1000;      # ISO ms -> epoch ms (fraction dropped)
  [.[] | select(.type=="note_accepted" or .type=="note_rejected" or .type=="note_superseded" or .type=="staging_resolve")]
  | group_by(.note_id) | map(min_by(.ts))                       # D-D collapse first
  | map(select(.session_id != null and .ts != null))
  | group_by(.session_id)
  | map(sort_by(.ts, .note_id)                                  # D-C: order within the session
        | reduce .[] as $r ({batches: [], prev: null};
            ($r.ts | ms) as $t
            | if .prev != null and ($t - .prev) > 300000        # D-B: only a strictly larger gap splits
              then {batches: (.batches + [1]), prev: $t}
              else {batches: (.batches[:-1] + [((.batches[-1] // 0) + 1)]), prev: $t} end)
        | .batches)
  | flatten | group_by(.) | map({size: .[0], batches: length})'
```

`fromdateiso8601` cannot read the sub-second fraction, so `ms` drops it and the recipe is
second-accurate; the `stats` tool parses full ISO milliseconds (`Date.parse`) and so respects the
boundary to the millisecond.

## (f) Which tools fail, and how often?

**Definition.** Count of `tool_error` events grouped by `tool` (the sanitized error text is not
aggregated).

```sh
cat "$EVENTS"/*.jsonl | jq -s '[.[] | select(.type=="tool_error")] | group_by(.tool) | map({tool: .[0].tool, count: length})'
```

## (g) How large is the event log?

**Definition.** Total bytes across the monthly `*.jsonl` files, plus the count of events per `type`.

```sh
wc -c "$EVENTS"/*.jsonl
cat "$EVENTS"/*.jsonl | jq -s 'group_by(.type) | map({type: .[0].type, count: length})'
```

> **Schema note (v1).** `note_deduped` is emitted **only on the NOOP path** — a same-note
> re-encounter below the supersede threshold — and carries `existing_id` + `similarity`.

> **Schema note (v2).** The write path was renamed and enriched. The rename map is:
> `note_staged -> remember`; `note_accepted` / `note_rejected` / `note_superseded ->
> staging_resolve{decision: accept|reject|supersede}`; `note_deduped -> remember{dedup.outcome:
> "noop"}`. A `remember` carries `note_type`, `body_len`, `anchors_n`, `source` and a `dedup`
> object (`outcome`, `nearest_id`, `similarity`, `supersede_threshold`, `noop_threshold`,
> `degraded`); a `staging_resolve` carries `decision`, `staged_to_resolved_ms`, `commit`,
> `superseded_id` and `suggested` (the last three null when a decision does not use them). Every
> recipe above reads **both dialects** so a log spanning the migration counts identically.
> New v2-only events — `rebuild`, `session_start`, `session_end`, `tool_error` — do not feed the
> metrics above. An **absent `session_end`** means the session was cut off (SIGKILL, kernel panic,
> killed terminal), **not** a data error: Phase-6 duration analysis treats a missing end as normal.

> **Schema note (v3).** The `recall` event is enriched. Alongside `query`, `budget`, `returned_ids`
> and `degraded` it now carries: `mode` (`fused` | `fts_only` | `vector_only` | `none`, from which
> channels ran), `corpus_size` (the full index note count, `SELECT COUNT(*) FROM meta` — **not** the
> candidate union), `timings` (`embed_ms`, `fts_ms`, `fusion_ms`), and `candidates` — up to the
> top **20** notes in fused (pre-budget-cutoff) order. Each candidate records `id`, `type`,
> `fts_rank`, `vector_rank`, `cosine`, `rrf`, `staleness_boost`, `token_est` and the `in_budget`
> decision (`fts_rank` / `vector_rank` / `cosine` / `token_est` / `type` are null when a channel did
> not rank the note or its body was absent). All other events are unchanged from v2.

> **Schema note (v4).** Three workflow-run event types are added — `workflow_run_started` (the run's
> full phase-graph definition + branch anchor + recall config), `workflow_step_applied` (the fold
> source for branch-scoped resume: `result_kind`, `step_id`, `outcome`, `attempt`, an optional `gates`
> report, `harvested_n`), and `workflow_run_marked_stale` (an orphaned run whose branch is gone). All
> carry the project `branch`. None feed the metrics above (the jq recipes filter by specific event
> types); the log-footprint recipe counts them generically by `.type`. Every event now stamps
> `schema_version` 4; the reader normalizes older events and `replay.ts` still refuses only a
> `schema_version` **above** its own. All memory events are unchanged from v3.

## Offline replay

The candidate list makes each recall decision **reproducible offline**. `scripts/replay.ts` rebuilds
the ranked, budget-filled decision vector from the logged fusion inputs alone — it never re-runs FTS
or the embedder and **never reads `query`**, so it is safe against a redacted log. With no flags it
**verifies** that the recorded decisions still reproduce (exit 0 when at least one recall reproduces
and all do, else 1); any flag switches to an **alternative** report showing how different parameters
would reshape the decisions (always exit 0). A refusal, I/O failure, corrupt candidate, or usage error
exits 2.

```sh
# Verify the recorded decisions reproduce.
bun scripts/replay.ts "$EVENTS"

# Ask what a different budget or fusion weighting would have done.
bun scripts/replay.ts "$EVENTS" --budget 4000 --staleness-weight 0
```

Replay refuses any log containing an event whose `schema_version` exceeds the tool's own (it names
both versions), and counts pre-v3 recall events — which carry no candidates — as skipped rather than
failed. Because only the logged **top-20 prefix** is available, a recall whose candidate window is
full while the corpus is larger is marked window-limited: *the corpus exceeds the 20-candidate window
(analysis may be truncated)*. The OK / MISMATCH verdict over that logged prefix is still exact; only
analysis beyond the window is out of reach.
