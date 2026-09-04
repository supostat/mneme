# mneme

[![CI](https://github.com/supostat/mneme/actions/workflows/ci.yml/badge.svg)](https://github.com/supostat/mneme/actions/workflows/ci.yml)

mneme is a local-first MCP memory server for Claude Code, over a personal, cross-project note corpus
that lives on your machine. Every remembered note is **staged for human review** rather than saved
silently: you accept, reject, or supersede staged notes yourself, so the corpus only ever grows with
memory you approved. Recall fuses full-text and vector search under a token budget and logs its
candidates so retrieval decisions can be replayed and audited offline.

The binary exposes fourteen MCP tools over stdio. Five are the memory surface: `remember` (stage a
note), `recall` (token-budgeted fused retrieval), `staging_list` and `staging_resolve` (review and
accept/reject/supersede staged notes), and `stats` (reuse and footprint metrics from the event log).
Five curate the accepted corpus: `notes_list` (one line per live note with anchor health, or one full
note by id), `note_retire` (queue a retirement — the decision still travels through the
`staging_resolve` human gate, and an accepted retire keeps the file as history while recall stops
seeing it), `anchor_repair` (queue an anchor replacement for a note whose anchor path went missing —
same gate, and an accepted repair rewrites the address while the body stays immutable), and
`anchor_sweep` (batch-stage repairs by tracing renames in the project's git history: a single
confident successor is staged, ambiguity and outright deletions are only reported, and a repaired
corpus sweeps to silence), and `corpus_adopt` (merge a corpus that drifted apart from this one — see
Merging corpora below). The remaining five drive the workflow engine: `workflow_start` opens a run anchored to
the current project branch; `workflow_step` is the live executor — it loops directives (recall at
phase start, gated steps, harvest on close) decided by the reducer, resumes a branch's unfinished
run from the event log after an interruption, and never silently resumes a run whose branch is gone;
`workflow_migrate` converts a spec's gameplan into runnable phase files; `workflow_abandon`
records a terminal human refusal of an unfinished run, distinct from failure; and `workflow_survey`
is the read-only orientation — the current branch's run, its pending directive and last activity,
staged-note count, and runs elsewhere, as a map or (with `brief: true`) a single line — writing
nothing: no event, no file, no stale mark.

The server ships as a single self-contained compiled binary, distributed through the separate
`mneme-plugin` repository. This repository is the source; the binary is built from it by the bridge
described below.

## Sharing one corpus between working copies

By default a project's corpus directory is derived from the project's absolute path, so two working
copies of the same project — two folders with different names — grow two independent corpora and
neither sees the other's notes. Give both copies the same corpus name in their `.mneme.json` to point
them at one corpus:

```json
{ "corpus": { "name": "my-project" } }
```

The name is a slug (`^[a-z0-9][a-z0-9_-]{0,63}$`) naming a directory under `~/.mneme/`; a value with
slashes or dots is refused. `MNEME_CORPUS_NAME` overrides the file. A project without the key keeps
the historical path-derived directory, byte for byte. Two live sessions may share one corpus: the
index is opened in WAL mode with a busy timeout, event-log lines are appended atomically, and a
session that loses the race for the corpus repo's git lock is told to retry rather than left with a
half-written commit.

### Moving an existing corpus onto a name

Renaming is a manual, reversible move — the engine deliberately does not relocate corpora for you:

```
mv ~/.mneme/-Users-you-Projects-my-project ~/.mneme/my-project
```

then add the `corpus.name` key to `.mneme.json` and delete any symlinks you had created under
`~/.mneme/` to fake a shared corpus. The first run stamps the name into the corpus manifest.

### Merging corpora

When both copies already accumulated notes, merge them with the `corpus_adopt` tool, giving it the
OTHER corpus's directory:

```
corpus_adopt { "source_corpus_dir": "~/.mneme/-Users-you-Projects-my-project-copy" }
```

Notes cross without re-staging — both sides already passed the human review gate — while a note
already present by id, or one the receiving corpus's dedup recognizes as the same knowledge, is
skipped and reported. The source corpus is only read; deleting that folder afterwards is your
decision. Adoption needs the embedder running, because the dedup check is the point.

## Building the plugin

`scripts/build-plugin.ts` compiles the server from this repository into a plugin distribution repo.
It never writes the plugin manifest — the plugin repo owns its own version.

### Prerequisites

- Bun 1.3 or newer (runtime, package manager, and test runner).
- `git` on `PATH` (the server provisions its corpus as a git repository on first start).

### Command

```sh
bun scripts/build-plugin.ts /path/to/mneme-plugin
```

or, equivalently, via the environment variable:

```sh
MNEME_PLUGIN_PATH=/path/to/mneme-plugin bun scripts/build-plugin.ts
```

### What it does

1. Validates the plugin manifest as a path guard — a directory without a valid
   `<plugin>/plugin/.claude-plugin/plugin.json` is not a plugin repo and refuses the build. The
   manifest is never written: the plugin's version is managed by the plugin repo's own automation.
2. Compiles `src/mcp-server.ts` into `<plugin>/plugin/bin/mneme` — a self-contained binary of roughly 64 MB.
   The plugin repo git-ignores `plugin/bin/`; the binary is reproducible from source and never committed.
   The engine's `package.json` version is baked into the binary itself.
3. Prints the output path, version, size (MiB and bytes), and build time.

Re-running the command against the same plugin path is idempotent: the compile is byte-deterministic,
so an unchanged source tree reproduces a byte-identical binary.

If the compile fails, the command exits non-zero. A missing plugin path exits with code 2; a bad
plugin path or an invalid manifest exits with code 1 before anything is written.

## Releasing

A release is one manual step: raise the version in `package.json`, commit, push to `main`.

```sh
npm version patch --no-git-tag-version   # or edit package.json by hand
git commit -am "Raise the engine to <version>" && git push
```

CI (`.github/workflows/ci.yml`) tags the release itself. On every run it compares `package.json`
with the highest `v*` tag (`bun scripts/require-unreleased-version.ts --decide`, after a checkout
with `fetch-tags: true`). On a push to `main` whose version is above that tag, and only after the
full suite is green, it pushes `v<version>` under `RELEASE_TOKEN` — first as a `git push --dry-run`
guard, then for real. A push whose version equals the tag is a quiet no-op; a version below the tag
fails the run. Any other branch and every pull request only runs the gates. A manual `git tag
v<version> && git push --tags` remains a valid fallback — the release pipeline triggers on any `v*`
tag, whoever pushes it.

If the guard step fails, `RELEASE_TOKEN` cannot write to this repository: widen the PAT (below) and
re-run the failed job on the same commit — nothing was written before the dry-run, so the re-run
tags and releases as if it were the first attempt.

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs automatically:

1. The full local gates on a clean runner: `bun run typecheck` and `bun test` — a red suite stops the
   release before anything is built.
2. `bun run build-release -- --tag <tag>`: the tag must equal `v<package.json version>` or the build
   fails; then the four cross-compiled binaries (`mneme-darwin-arm64`, `mneme-darwin-x64`,
   `mneme-linux-x64`, `mneme-linux-arm64` — versionless names, the version lives in the release tag)
   land in `dist-release/` with `SHA256SUMS` and `dispatch.json`.
3. `gh release create` publishes the binaries and `SHA256SUMS` as a GitHub Release in
   `supostat/mneme-plugin` under the namespaced tag `engine-v<version>` — user-facing artifacts live
   in the distribution repo, and the namespace keeps engine releases clear of the plugin's own `v*` tags.
4. `gh api .../dispatches` sends the `engine-release` event with `{version, assets, sha256}` — the
   asset URLs and per-target digests the plugin repo pins into its `release.json`.

Both workflows use a single secret, `RELEASE_TOKEN`: a fine-grained PAT with contents:write on
`supostat/mneme` (CI pushes the release tag with it — a tag pushed under the default `GITHUB_TOKEN`
would not trigger `release.yml`) and contents:write plus dispatch access on `supostat/mneme-plugin`
(the release publishes there). `tests/ci-workflow.test.ts` and `tests/release-workflow.test.ts` pin
both workflows' structure, including that no other secret is referenced. What the tests cannot
prove is that GitHub starts `release.yml` for a tag CI pushed — that is confirmed by the first live
release after any change to the tagging steps.

If a release fails partway: delete the tag, fix the problem, and re-tag with a NEW version — never
reuse a tag name. Published release assets are immutable; the plugin repo's pins reference them
forever, and a rerun under the same tag fails on `gh release create` by design.
