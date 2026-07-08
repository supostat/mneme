#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";

// Standalone bridge from this CODE repo into a mneme-plugin distribution repo: compile the MCP server
// into <plugin>/bin/mneme and stamp this repo's package.json version into the plugin manifest. The
// entry is absolute so the spawned compile resolves mcp-server.ts's `import "../package.json"` to the
// SAME package.json imported here — the baked binary version equals the stamped version by construction.
export const MNEME_PLUGIN_PATH_ENV = "MNEME_PLUGIN_PATH";
const REPO_ROOT = join(import.meta.dir, "..");
const SERVER_ENTRY = join(REPO_ROOT, "src", "mcp-server.ts");
const MNEME_VERSION = packageJson.version;
const MANIFEST_SEGMENTS = [".claude-plugin", "plugin.json"] as const;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const USAGE = "usage: bun scripts/build-plugin.ts <plugin-path>  (or set MNEME_PLUGIN_PATH=<plugin-path>)";

export interface PluginTargets {
  manifestPath: string;
  binDir: string;
  outfile: string;
  manifest: Record<string, unknown>;
}

export interface BuildReport {
  version: string;
  outfile: string;
  sizeBytes: number;
  buildTimeMs: number;
}

export function selectPluginPath(argv: string[], environmentPluginPath: string | undefined): string {
  if (argv.length > 1) {
    throw new Error(`unexpected extra arguments: ${argv.slice(1).join(" ")}\n${USAGE}`);
  }
  const pluginPath = argv[0] ?? environmentPluginPath;
  if (pluginPath === undefined) {
    throw new Error(`missing <plugin-path>\n${USAGE}`);
  }
  return pluginPath;
}

// Validates and parses everything that could fail BEFORE the compile writes anything, so a bad plugin
// path or malformed manifest never leaves a binary behind without a matching version stamp.
export function resolvePluginTargets(pluginPath: string): PluginTargets {
  if (!existsSync(pluginPath) || !statSync(pluginPath).isDirectory()) {
    throw new Error(`plugin path is not an existing directory: ${pluginPath}`);
  }
  const manifestPath = join(pluginPath, ...MANIFEST_SEGMENTS);
  if (!existsSync(manifestPath)) {
    throw new Error(`plugin manifest not found: ${manifestPath}`);
  }
  const binDir = join(pluginPath, "bin");
  return { manifestPath, binDir, outfile: join(binDir, "mneme"), manifest: parseManifest(manifestPath) };
}

function parseManifest(manifestPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`plugin manifest is not valid JSON: ${manifestPath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`plugin manifest is not a JSON object: ${manifestPath}`);
  }
  return parsed as Record<string, unknown>;
}

export async function compileServer(binDir: string, outfile: string): Promise<void> {
  mkdirSync(binDir, { recursive: true });
  // stdout is ignored, not piped: the build writes the binary to --outfile and its diagnostics to
  // stderr, so an unread stdout pipe would only risk the child blocking once it fills the OS buffer.
  const subprocess = Bun.spawn({
    cmd: ["bun", "build", "--compile", SERVER_ENTRY, "--outfile", outfile],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`bun build --compile failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

// Idempotent: spreading the already-parsed manifest keeps existing key order and updates (or appends)
// version in place, so a re-run rewrites byte-identical content.
export function stampManifestVersion(
  manifestPath: string,
  manifest: Record<string, unknown>,
  version: string,
): void {
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
}

export async function buildPlugin(pluginPath: string): Promise<BuildReport> {
  const startedAt = performance.now();
  const targets = resolvePluginTargets(pluginPath);
  await compileServer(targets.binDir, targets.outfile);
  stampManifestVersion(targets.manifestPath, targets.manifest, MNEME_VERSION);
  return {
    version: MNEME_VERSION,
    outfile: targets.outfile,
    sizeBytes: statSync(targets.outfile).size,
    buildTimeMs: performance.now() - startedAt,
  };
}

export function formatBuildReport(report: BuildReport): string {
  const mebibytes = (report.sizeBytes / BYTES_PER_MEBIBYTE).toFixed(1);
  return [
    `Compiled ${report.outfile}`,
    `  version:    ${report.version}`,
    `  size:       ${mebibytes} MiB (${report.sizeBytes} bytes)`,
    `  build time: ${Math.round(report.buildTimeMs)} ms`,
    "",
  ].join("\n");
}

export async function main(argv: string[], environmentPluginPath: string | undefined): Promise<number> {
  let pluginPath: string;
  try {
    pluginPath = selectPluginPath(argv, environmentPluginPath);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  try {
    process.stdout.write(formatBuildReport(await buildPlugin(pluginPath)));
    return 0;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env[MNEME_PLUGIN_PATH_ENV]).then((code) => {
    process.exitCode = code;
  });
}
