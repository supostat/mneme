import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import packageJson from "../package.json";
import { selectPluginPath, buildPlugin, main, formatBuildReport, stampManifestVersion } from "./build-plugin";
import type { BuildReport } from "./build-plugin";

// A minimal but valid plugin manifest without a version key, matching the real plugin repo's shape:
// build-plugin stamps the version, so the fixture must start unstamped to prove stamping happens.
const VALID_MANIFEST =
  JSON.stringify({ name: "mneme", mcpServers: { mneme: { command: "${CLAUDE_PLUGIN_ROOT}/bin/mneme" } } }, null, 2) + "\n";

// Every fixture, home, and cwd is a fresh mkdtemp dir tracked here; afterAll removes them all so the
// ~64 MB binaries each build produces do not accumulate across runs.
const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createPluginFixture(manifestContent: string): string {
  const pluginPath = makeTemporaryDirectory("mneme-plugin-fixture-");
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), manifestContent);
  return pluginPath;
}

function manifestPathOf(pluginPath: string): string {
  return join(pluginPath, ".claude-plugin", "plugin.json");
}

function readStampedVersion(pluginPath: string): unknown {
  return JSON.parse(readFileSync(manifestPathOf(pluginPath), "utf8")).version;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// main() writes its report to stdout/stderr; swallow both so exit-code assertions stay quiet.
async function runMainSilently(argv: string[], environmentPluginPath: string | undefined): Promise<number> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const swallow = (): boolean => true;
  process.stdout.write = swallow as typeof process.stdout.write;
  process.stderr.write = swallow as typeof process.stderr.write;
  try {
    return await main(argv, environmentPluginPath);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

interface ServerRun {
  exitCode: number;
  timedOut: boolean;
  tempHome: string;
}

// The compiled server IS the MCP server: with stdin ignored it reads EOF immediately, provisions its
// corpus under HOME/.mneme, and exits. HOME is redirected so it never touches the real corpus; PATH is
// preserved via ...process.env so the child's `git init` resolves git. timedOut proves NATURAL exit
// (a SIGTERM handler would also exit 0, which would otherwise mask a broken natural shutdown).
async function runCompiledServer(outfile: string): Promise<ServerRun> {
  const tempHome = makeTemporaryDirectory("mneme-smoke-home-");
  const tempCwd = makeTemporaryDirectory("mneme-smoke-cwd-");
  const child = Bun.spawn({
    cmd: [outfile],
    cwd: tempCwd,
    env: { ...process.env, HOME: tempHome },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 15_000);
  const [, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, timedOut, tempHome };
}

let sharedPluginPath: string;
let sharedReport: BuildReport;

// One compile shared by the version-stamping and smoke tests. Bun's default per-test timeout is 5s;
// the compile is given a wide 60s ceiling.
beforeAll(async () => {
  sharedPluginPath = createPluginFixture(VALID_MANIFEST);
  sharedReport = await buildPlugin(sharedPluginPath);
}, 60_000);

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("selectPluginPath argument resolution", () => {
  test("throws a usage error when no path is given and no environment path is set", () => {
    expect(() => selectPluginPath([], undefined)).toThrow("missing <plugin-path>");
  });

  test("throws a usage error on extra positional arguments", () => {
    expect(() => selectPluginPath(["/a", "/b"], undefined)).toThrow("unexpected extra arguments");
  });

  test("falls back to the environment path when no argument is given", () => {
    expect(selectPluginPath([], "/from/environment")).toBe("/from/environment");
  });

  test("an explicit argument overrides the environment path", () => {
    expect(selectPluginPath(["/from/argument"], "/from/environment")).toBe("/from/argument");
  });
});

describe("buildPlugin stamps and reports", () => {
  test("stamps this repo's package.json version into the plugin manifest", () => {
    expect(sharedReport.version).toBe(packageJson.version);
    expect(readStampedVersion(sharedPluginPath)).toBe(packageJson.version);
  });

  test("reports the produced binary's real size", () => {
    expect(sharedReport.outfile).toBe(join(sharedPluginPath, "bin", "mneme"));
    expect(sharedReport.sizeBytes).toBeGreaterThan(0);
  });
});

describe("stampManifestVersion", () => {
  test("replaces a pre-existing version in place, preserving key order", () => {
    const pluginPath = createPluginFixture(
      JSON.stringify({ name: "mneme", version: "0.0.1", mcpServers: {} }, null, 2) + "\n",
    );
    const path = manifestPathOf(pluginPath);

    stampManifestVersion(path, JSON.parse(readFileSync(path, "utf8")), "9.9.9");

    const written = readFileSync(path, "utf8");
    expect(JSON.parse(written).version).toBe("9.9.9");
    expect(written.indexOf('"name"')).toBeLessThan(written.indexOf('"version"'));
    expect(written.indexOf('"version"')).toBeLessThan(written.indexOf('"mcpServers"'));
  });
});

describe("formatBuildReport", () => {
  test("renders the outfile, version, size in MiB and bytes, and rounded build time", () => {
    const rendered = formatBuildReport({
      version: "1.2.3",
      outfile: "/tmp/plugin/bin/mneme",
      sizeBytes: 64_568_930,
      buildTimeMs: 150.7,
    });

    expect(rendered).toContain("/tmp/plugin/bin/mneme");
    expect(rendered).toContain("1.2.3");
    expect(rendered).toContain("61.6 MiB (64568930 bytes)");
    expect(rendered).toContain("151 ms");
  });
});

describe("the compiled binary is a runnable server", () => {
  test("starts, provisions its corpus under HOME, and exits on its own", async () => {
    const run = await runCompiledServer(sharedReport.outfile);

    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(run.tempHome, ".mneme"))).toBe(true);
  }, 30_000);
});

describe("rebuilding is idempotent", () => {
  // bun build --compile is byte-deterministic here (verified: two compiles share one sha256), so the
  // rebuild must reproduce a byte-identical binary AND a byte-identical stamped manifest.
  test("a second build reproduces the binary and manifest byte for byte", async () => {
    const pluginPath = createPluginFixture(VALID_MANIFEST);

    const first = await buildPlugin(pluginPath);
    const firstBinaryHash = sha256(first.outfile);
    const firstManifest = readFileSync(manifestPathOf(pluginPath), "utf8");

    const second = await buildPlugin(pluginPath);

    expect(sha256(second.outfile)).toBe(firstBinaryHash);
    expect(readFileSync(manifestPathOf(pluginPath), "utf8")).toBe(firstManifest);
    expect(second.version).toBe(first.version);
  }, 60_000);
});

describe("bad input fails closed before any binary is written", () => {
  test("a usage error returns exit code 2", async () => {
    expect(await runMainSilently([], undefined)).toBe(2);
  });

  test("a nonexistent plugin path returns exit code 1", async () => {
    const missing = join(makeTemporaryDirectory("mneme-plugin-missing-"), "absent");
    expect(await runMainSilently([missing], undefined)).toBe(1);
  });

  test("a plugin path without a manifest returns 1 and writes no bin directory", async () => {
    const bareDirectory = makeTemporaryDirectory("mneme-plugin-bare-");

    expect(await runMainSilently([bareDirectory], undefined)).toBe(1);
    expect(existsSync(join(bareDirectory, "bin"))).toBe(false);
  });

  test("an invalid-JSON manifest returns 1 and writes no binary", async () => {
    const pluginPath = createPluginFixture("{ not valid json");

    expect(await runMainSilently([pluginPath], undefined)).toBe(1);
    expect(existsSync(join(pluginPath, "bin", "mneme"))).toBe(false);
  });

  test("a JSON-array manifest fails the object guard and writes no binary", async () => {
    const pluginPath = createPluginFixture("[]\n");

    expect(await runMainSilently([pluginPath], undefined)).toBe(1);
    expect(existsSync(join(pluginPath, "bin", "mneme"))).toBe(false);
  });
});
