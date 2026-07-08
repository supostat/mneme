# mneme

mneme is a local-first MCP memory server for Claude Code. It gives an agent two tools —
`remember` and `recall` — over a personal, cross-project note corpus that lives on your machine.
Every remembered note is **staged for human review** rather than saved silently: you accept, reject,
or supersede staged notes yourself, so the corpus only ever grows with memory you approved. Recall
fuses full-text and vector search under a token budget and logs its candidates so retrieval decisions
can be replayed and audited offline.

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

1. Compiles `src/mcp-server.ts` into `<plugin>/bin/mneme` — a self-contained binary of roughly 64 MB.
   The plugin repo git-ignores `bin/`; the binary is reproducible from source and never committed.
2. Stamps this repository's `package.json` version into `<plugin>/.claude-plugin/plugin.json`. The
   version baked into the binary and the version written to the manifest are the same by construction.
3. Prints the output path, version, size (MiB and bytes), and build time.

Re-running the command against the same plugin path is idempotent: the compile is byte-deterministic,
so an unchanged source tree reproduces a byte-identical binary and an unchanged manifest.

If the compile fails, the command exits non-zero and leaves the manifest untouched — the manifest is
validated and the version is stamped only after a successful compile, so a failed build never leaves a
binary and manifest out of sync. A missing plugin path exits with code 2; a bad plugin path or an
invalid manifest exits with code 1 before anything is written.
