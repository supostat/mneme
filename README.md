# mneme

[![CI](https://github.com/supostat/mneme/actions/workflows/ci.yml/badge.svg)](https://github.com/supostat/mneme/actions/workflows/ci.yml)

mneme is a local-first MCP memory server for Claude Code, over a personal, cross-project note corpus
that lives on your machine. Every remembered note is **staged for human review** rather than saved
silently: you accept, reject, or supersede staged notes yourself, so the corpus only ever grows with
memory you approved. Recall fuses full-text and vector search under a token budget and logs its
candidates so retrieval decisions can be replayed and audited offline.

The binary exposes eleven MCP tools over stdio. Five are the memory surface: `remember` (stage a
note), `recall` (token-budgeted fused retrieval), `staging_list` and `staging_resolve` (review and
accept/reject/supersede staged notes), and `stats` (reuse and footprint metrics from the event log).
Two curate the accepted corpus: `notes_list` (one line per live note with anchor health, or one full
note by id) and `note_retire` (queue a retirement — the decision still travels through the
`staging_resolve` human gate, and an accepted retire keeps the file as history while recall stops
seeing it). The remaining four drive the workflow engine: `workflow_start` opens a run anchored to
the current project branch; `workflow_step` is the live executor — it loops directives (recall at
phase start, gated steps, harvest on close) decided by the reducer, resumes a branch's unfinished
run from the event log after an interruption, and never silently resumes a run whose branch is gone;
`workflow_migrate` converts a spec's gameplan into runnable phase files; and `workflow_abandon`
records a terminal human refusal of an unfinished run, distinct from failure.

The server ships as a single self-contained compiled binary, distributed through the separate
`mneme-plugin` repository. This repository is the source; the binary is built from it by the bridge
described below.

## Building the plugin

`scripts/build-plugin.ts` compiles the server from this repository into a plugin distribution repo and
stamps this repo's version into the plugin manifest.

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

1. Compiles `src/mcp-server.ts` into `<plugin>/plugin/bin/mneme` — a self-contained binary of roughly 64 MB.
   The plugin repo git-ignores `plugin/bin/`; the binary is reproducible from source and never committed.
2. Stamps this repository's `package.json` version into `<plugin>/plugin/.claude-plugin/plugin.json`. The
   version baked into the binary and the version written to the manifest are the same by construction.
3. Prints the output path, version, size (MiB and bytes), and build time.

Re-running the command against the same plugin path is idempotent: the compile is byte-deterministic,
so an unchanged source tree reproduces a byte-identical binary and an unchanged manifest.

If the compile fails, the command exits non-zero and leaves the manifest untouched — the manifest is
validated and the version is stamped only after a successful compile, so a failed build never leaves a
binary and manifest out of sync. A missing plugin path exits with code 2; a bad plugin path or an
invalid manifest exits with code 1 before anything is written.
