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

Every metric is anchored to the **accepted population**: the distinct `note_id` of
`note_accepted` events. This population is **historical** — it includes notes later
superseded. Rejected notes are outside it (they never emit `note_accepted`); NOOP dedups are
outside it (they emit `note_deduped`).

```sh
cat "$EVENTS"/*.jsonl | jq -s '[.[] | select(.type=="note_accepted") | .note_id] | unique'
```

The **superseded ids** — the set to subtract from the accepted population to get the *live*
corpus — are:

```sh
cat "$EVENTS"/*.jsonl | jq -s '[.[] | select(.type=="note_superseded") | .superseded_id] | unique'
```

`liveAccepted` is then the accepted population minus these ids; the corpus-size recipe below
computes the full difference (`$accepted - $superseded`).

## (a) Are accepted notes reused across sessions?

**Definition.** Denominator = the whole accepted population (distinct `note_accepted.note_id`).
Numerator = accepted notes whose id appears in some `recall.returned_ids` in a session
**different from the note's creation (staging) session**, at a timestamp strictly later than the
staging timestamp. The anchor is the note's **`note_staged`** event (earliest wins), *not* its
acceptance: a note staged in `S1`, accepted in `S2`, and recalled in `S2` crossed a session
boundary at creation and must count. A note reused *before* it was superseded still counts. An
accepted note with no `note_staged` anchor cannot be ordered and is not counted.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  ([.[] | select(.type=="note_accepted") | .note_id] | unique) as $accepted
  | (reduce (.[] | select(.type=="note_staged")) as $e ({};
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
  ([.[] | select(.type=="note_accepted") | .note_id] | unique) as $accepted
  | ([.[] | select(.type=="recall") | (.returned_ids // [])[]] | unique) as $retrieved
  | ([.[] | select(.type=="note_superseded") | .superseded_id] | unique) as $superseded
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

Live accepted notes joined to their `note_staged.note_type`; unmatched notes fall into the
`untyped` bucket. Computed over `liveAccepted`, not the historical population.

```sh
cat "$EVENTS"/*.jsonl | jq -s '
  ([.[] | select(.type=="note_accepted") | .note_id] | unique) as $accepted
  | ([.[] | select(.type=="note_superseded") | .superseded_id] | unique) as $superseded
  | ([$accepted[] as $id | select(($superseded | index($id)) == null) | $id]) as $live
  | (reduce (.[] | select(.type=="note_staged")) as $e ({};
       if .[$e.note_id] == null then .[$e.note_id] = $e.note_type else . end)) as $types
  | reduce $live[] as $id ({}; ($types[$id] // "untyped") as $t | .[$t] += 1)'
```

## NOOP confirmations

A separate value signal: the count of `note_deduped` events — write-path re-encounters of
knowledge the corpus already holds. Not part of (a)/(b).

```sh
cat "$EVENTS"/*.jsonl | jq -s '[.[] | select(.type=="note_deduped")] | length'
```

Alongside the event count, the `stats` tool reports the count of **distinct `existing_id`** — how
many *different* notes were re-confirmed. Ten encounters of one note and ten notes seen once each
both yield a count of 10, but the first is one note re-confirmed ten times and the second is ten
notes each re-confirmed once: different corpus stories.

```sh
cat "$EVENTS"/*.jsonl | jq -s '[.[] | select(.type=="note_deduped") | .existing_id] | unique | length'
```

> **Schema note (v1).** `note_deduped` is emitted **only on the NOOP path** — a same-note
> re-encounter below the supersede threshold. A future Phase-5 dedup-event extension that emits
> `note_deduped` (or a successor) on other paths must re-scope both recipes above, or they would
> silently count the wrong thing.
