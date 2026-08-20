# BENCH.md — retrieval-layer benchmark methodology (LoCoMo, LongMemEval-S)

This page documents HOW the benchmark harness in `scripts/bench/` measures, and
deliberately publishes NO numbers. Per the locality principle of `docs/METRICS.md`,
results are computed locally on your machine; publishing any aggregate is a separate
human decision, and any published figure must carry the framing footnote below.

## The framing footnote (obligatory for any published figure)

LoCoMo and LongMemEval measure conversational personalization; mneme is a curated
development memory. A head-to-head comparison with memory layers is impossible by
definition, because mneme's central mechanism — the human-gate — is switched OFF in a
benchmark run: the "curator" is an auto-accepting script (`scripts/bench/ingest.ts`
resolves every staged note programmatically). What the harness measures is therefore
ONLY the retrieval layer — FTS + cosine + RRF fusion + budget + threshold — on a
foreign domain. Nothing here estimates the value of curation, anchors, staleness, or
the human-gate itself.

Why measure at all: (a) volume stress the real corpora never reach (hundreds of notes
per case against at most ~200 in live use); (b) a direct abstention measurement —
LongMemEval carries questions whose answer is absent from the haystack; (c) knowledge
updates land on `supersede`, the one local-first mechanism where updating knowledge is
a model primitive; (d) calibration against known reference points.

Calibration context, not head-to-head comparison: GPT-4o-mini with NO memory scores
57.6% on LongMemEval; an independent run of open-source Mem0 measured 32.4% against
the managed version's self-reported 93.4%. These are QA-accuracy numbers produced with
LLM judges; our metrics are retrieval-only and deterministic, so the figures frame the
landscape's honesty spread rather than compete in it.

## Corpus construction (ingest)

- One isolated corpus per case: a LoCoMo case is one conversation (its whole QA set
  shares the haystack); a LongMemEval-S case is one question with its own haystack.
  Corpora live in temporary `corpusHome` directories and never touch working
  `~/.mneme` corpora.
- Granularity — hybrid, forced through the engine's own primitives: a session's turns
  become the note BODY, dataset-marked entities (LoCoMo speakers, session dates)
  become TAGS, anchors stay empty (legal and staleness-neutral). The engine caps a
  note body at 1500 code points, so longer sessions are chunked MECHANICALLY at line
  boundaries into several notes; evidence stays at SESSION level — a retrieval hit on
  any chunk counts as a hit on the session. Semantic fact-splitting (how competing
  memory layers index) was rejected: it is foreign to mneme's note model.
- Rendering: LongMemEval turns render content-only — the `user:`/`assistant:` role
  labels are structural markup whose tokens would lexically match nearly every
  question ("the user ...") through the FTS channel. LoCoMo keeps speaker names:
  there they are content-bearing entities the questions reference.
- Defang: the engine's write path fail-closed rejects foreign tool/protocol markup in
  a note body, and real sessions do carry such fragments (`<html ...` inside pasted
  pages). The scripted curator neutralizes exactly the engine-forbidden patterns
  mechanically — the opening bracket becomes `‹` (U+2039), fence literals gain the
  same mark, framing-breaking code points become newlines — so lexical tokens survive
  for FTS; anything the list misses still fails closed on the engine's own gate.
- The write path is the engine's own: programmatic `remember` + `stagingResolve`
  (accept or supersede) via `src/staging.ts`, followed by the engine's own index
  rebuild with the production embedder. Dedup is disabled via config thresholds
  (noop/supersede = 1): the benchmark corpus must mirror the haystack one-to-one, and
  the dedup gate belongs to the disabled curator, not to the measured retrieval layer.
- Knowledge-update modes (the A/B this harness exists for):
  - `coexist` — every version of a fact is accepted; ranking decides.
  - `supersede` — dataset-labeled evidence chains (LongMemEval `knowledge-update`
    questions ONLY; never heuristics) resolve each later session as superseding its
    predecessor, chunk-for-chunk (chain sessions are chunked to the chain's maximum
    count). A superseded note leaves the index entirely.
  - LoCoMo carries no update labels and runs in `coexist` only.

## Measurement (run + report)

- Questions run through the LIVE `src/recall.ts` — no second scorer exists anywhere
  in the harness; fusion, threshold (cosine 0.35, FTS bypass), and the cold-start
  floor (top-3 low-confidence) are exactly the production code path.
- Metrics are computed from the recall EVENT LOG (`readEvents` + the engine's own
  event schema), not from in-process return values — any offline reader can recompute
  them.
- Recall@5/10 reads the event's `candidates` window (pre-threshold, fused order,
  window of 20): a session is retrieved at k when any of its chunk notes sits in the
  top-k candidates; a question's score is the fraction of its evidence sessions
  retrieved; the mode score is the macro-average over questions. The aggregate covers
  STANDARD questions only: a knowledge-update question's evidence chain includes the
  outdated sessions that supersede mode removes on purpose, so it is measured solely
  in its own section — and the standard-question numbers of both modes must coincide,
  since their corpora differ only in update chains (a free invariant check).
- Abstention reads the final `returned_ids`: a question is abstained when the return
  is empty OR nothing in it passes the engine's own threshold predicate
  (`passesRecallThreshold`) — the latter is precisely the cold-start floor's
  signature, derivable from the event without any engine change. Abstention-labeled
  questions report the abstention rate; answerable questions report false abstention.
  Known property, reported honestly: an FTS match bypasses the cosine threshold by
  design, so generic-token prefix matches on a foreign conversational domain keep
  lexical noise above the abstention gate.
- Knowledge-update questions additionally report: update Recall@k (the chain's LAST
  session retrieved) and stale hit@k (any EARLIER chain session retrieved). The
  coexist/supersede delta on these two is the headline result of the harness.
- The per-call recall budget is pinned at 100000 tokens — far above the production
  default of 2000 — so the token fill never decides `returned_ids`; the benchmark
  isolates ranking and threshold. The value is stamped into the report's provenance
  along with the dataset file's sha256, the configured embedder model, and the model
  stamped into `index_config` by the rebuild.

## Determinism

Ollama embeddings are float-nondeterministic. Reproducibility comes from the engine's
content-hash vector cache: within a built index, reruns are byte-identical; a rebuild
from scratch re-embeds and may drift by an epsilon. The embedder is the production
one (same client, same config resolution); the model is pinned in the report, and a
degraded state (embedder down OR vector-less index) aborts the run — a silent
FTS-only measurement is forbidden.

## Reproduce

```
bun scripts/bench/download.ts && bun scripts/bench/bench.ts --dataset longmemeval-s --mode both
```

Datasets download into `scripts/bench/datasets/` (git-ignored). If the download
fails, the script prints the manual instruction: LoCoMo from
https://github.com/snap-research/locomo (`data/locomo10.json`), LongMemEval-S from
https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
(`longmemeval_s_cleaned.json` — the author deprecated the original release in favor
of this cleaned variant, so published figures measured on the original are one more
reason the calibration anchors are context, not comparison). A missing dataset fails
closed with exit 2. LoCoMo runs as `bun scripts/bench/bench.ts --dataset locomo`
(coexist only).
