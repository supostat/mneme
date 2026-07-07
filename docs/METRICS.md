# Mneme proof metrics

The `stats` MCP tool reports proof metrics about the corpus **from the event log
alone** — no note bodies, no LLM, no index: the three proof questions below plus two corpus
signals (live corpus size by type, and NOOP write-path confirmations). This document states
each, how the `stats` tool computes it, and a hand-reproducible `jq` recipe you can run yourself.

`jq` is used here for **hand-verification only**. It is **not** a runtime dependency of
mneme; the tool computes every number in `src/stats.ts`.

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
