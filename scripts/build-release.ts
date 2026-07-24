#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";
import { compileServer } from "./build-plugin";

// Release matrix: every artifact bun can cross-compile from one runner. The list is the contract
// with the mneme-plugin launcher — a target added or removed here changes release.json downstream.
export const RELEASE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

export const CHECKSUMS_FILE_NAME = "SHA256SUMS";
const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_RELEASE_DIRECTORY = join(REPO_ROOT, "dist-release");
const MNEME_VERSION = packageJson.version;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const USAGE = "usage: bun scripts/build-release.ts [--tag <ref>]";

export type CompileFunction = (binDir: string, outfile: string, target: string) => Promise<void>;

export interface ReleaseArguments {
  tag: string | undefined;
}

export interface ReleaseArtifact {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface ReleaseReport {
  version: string;
  directory: string;
  artifacts: ReleaseArtifact[];
  buildTimeMs: number;
}

export function parseReleaseArguments(argv: string[]): ReleaseArguments {
  if (argv.length === 0) {
    return { tag: undefined };
  }
  const [flag, tag, ...extra] = argv;
  if (flag !== "--tag" || tag === undefined || extra.length > 0) {
    throw new Error(`invalid arguments: ${argv.join(" ")}\n${USAGE}`);
  }
  return { tag };
}

// The tag==version gate lives here, not in workflow YAML, so it stays unit-tested: the workflow
// only forwards $GITHUB_REF_NAME. A local run without --tag skips the check.
export function requireTagMatchesVersion(tag: string, version: string): void {
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(`tag ${tag} does not match package.json version ${version} (expected ${expectedTag})`);
  }
}

export function artifactName(version: string, target: string): string {
  return `mneme-${version}-${target}`;
}

// shasum -c format: two spaces between digest and file name.
export function checksumsContent(artifacts: ReleaseArtifact[]): string {
  return artifacts.map((artifact) => `${artifact.sha256}  ${artifact.fileName}`).join("\n") + "\n";
}

// SHA256SUMS is written only after EVERY target compiled: a failed target rejects before the write,
// so a partial artifact directory never carries a checksums file that vouches for it.
export async function buildRelease(
  releaseDirectory: string = DEFAULT_RELEASE_DIRECTORY,
  compile: CompileFunction = compileServer,
): Promise<ReleaseReport> {
  const startedAt = performance.now();
  rmSync(releaseDirectory, { recursive: true, force: true });
  mkdirSync(releaseDirectory, { recursive: true });
  const artifacts: ReleaseArtifact[] = [];
  for (const target of RELEASE_TARGETS) {
    const fileName = artifactName(MNEME_VERSION, target);
    const outfile = join(releaseDirectory, fileName);
    await compile(releaseDirectory, outfile, target);
    artifacts.push({
      fileName,
      sizeBytes: statSync(outfile).size,
      sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex"),
    });
  }
  writeFileSync(join(releaseDirectory, CHECKSUMS_FILE_NAME), checksumsContent(artifacts));
  return {
    version: MNEME_VERSION,
    directory: releaseDirectory,
    artifacts,
    buildTimeMs: performance.now() - startedAt,
  };
}

export function formatReleaseReport(report: ReleaseReport): string {
  const lines = [`Built release ${report.version} into ${report.directory}`];
  for (const artifact of report.artifacts) {
    const mebibytes = (artifact.sizeBytes / BYTES_PER_MEBIBYTE).toFixed(1);
    lines.push(`  ${artifact.fileName}  ${mebibytes} MiB  sha256:${artifact.sha256}`);
  }
  lines.push(`  ${CHECKSUMS_FILE_NAME}: ${report.artifacts.length} entries`);
  lines.push(`  build time: ${Math.round(report.buildTimeMs)} ms`);
  lines.push("");
  return lines.join("\n");
}

export async function main(
  argv: string[],
  releaseDirectory: string = DEFAULT_RELEASE_DIRECTORY,
  compile: CompileFunction = compileServer,
): Promise<number> {
  let releaseArguments: ReleaseArguments;
  try {
    releaseArguments = parseReleaseArguments(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  try {
    if (releaseArguments.tag !== undefined) {
      requireTagMatchesVersion(releaseArguments.tag, MNEME_VERSION);
    }
    process.stdout.write(formatReleaseReport(await buildRelease(releaseDirectory, compile)));
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
