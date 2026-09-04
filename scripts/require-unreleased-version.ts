#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import packageJson from "../package.json";
import { runGit } from "../src/git";

// Release gate for a change that ships: release.yml publishes on a v<version> tag and refuses a tag
// that differs from package.json (requireTagMatchesVersion in build-release.ts), and NOTHING bumps
// the version automatically — so a shipping change must raise it by hand, and this script makes
// that forgettable step a machine check. The verdict has four kinds; two modes read it:
//
// - strict (no flag), the phase gate: exit 0 only when package.json is STRICTLY above the highest
//   v* tag, exit 1 with a named reason otherwise.
// - --decide, the CI mode: `above` and `equal` both exit 0 — a push whose version was already
//   released is a quiet no-op, not a red build — and the outcome goes to $GITHUB_OUTPUT as
//   `unreleased=` and `version=` so the tagging steps route on it; `below` and a malformed
//   version still exit 1. Decide mode also REFUSES a checkout with no v* tag in sight: a CI
//   checkout that did not fetch tags would otherwise call every version unreleased and tag every
//   push, so "no tags" is a red step there, never a pass.
//
// In strict mode a repository with no v* tag has released nothing, so any version counts as above.
// The gate-runner spawns one argv without a shell, which is why this is a script and not a
// one-liner.

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TAG_GLOB = "v*";
const DECIDE_FLAG = "--decide";
export const NO_TAG_VISIBLE_MESSAGE =
  "no v* tag is visible: the checkout did not fetch tags (push the first tag by hand)";

export type VersionOrder = "above" | "equal" | "below" | "invalid";

export interface VersionVerdict {
  kind: VersionOrder;
  passes: boolean;
  version: string;
  message: string;
}

type Mode = "strict" | "decide";

export function parseSemver(value: string): [number, number, number] | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: [number, number, number], right: [number, number, number]): -1 | 0 | 1 {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

function verdict(kind: VersionOrder, version: string, message: string): VersionVerdict {
  return { kind, passes: kind === "above", version, message };
}

export function judgeUnreleasedVersion(version: string, latestTag: string | null): VersionVerdict {
  const parsedVersion = parseSemver(version);
  if (parsedVersion === null) {
    return verdict("invalid", version, `package.json version "${version}" is not a MAJOR.MINOR.PATCH version`);
  }
  if (latestTag === null) {
    return verdict("above", version, `version ${version} passes: no ${RELEASE_TAG_GLOB} tag exists, nothing was released yet`);
  }
  const parsedTag = parseSemver(latestTag);
  if (parsedTag === null) {
    return verdict("invalid", version, `latest release tag "${latestTag}" is not a v<MAJOR.MINOR.PATCH> tag`);
  }
  const order = compareSemver(parsedVersion, parsedTag);
  if (order > 0) {
    return verdict("above", version, `version ${version} is above the latest release tag ${latestTag}`);
  }
  if (order === 0) {
    return verdict("equal", version, `version ${version} equals the latest release tag ${latestTag}: raise the version before shipping`);
  }
  return verdict("below", version, `version ${version} is below the latest release tag ${latestTag}`);
}

export async function latestReleaseTag(repoDir: string): Promise<string | null> {
  const listed = await runGit(repoDir, ["tag", "--list", RELEASE_TAG_GLOB, "--sort=-v:refname"]);
  if (listed.exitCode !== 0) {
    throw new Error(`git failed to list release tags: ${listed.stderr.trim()}`);
  }
  const first = listed.stdout.split("\n")[0]?.trim() ?? "";
  return first === "" ? null : first;
}

// The outputs CI routes on. Only a version that is safe to act on gets outputs at all: `below` and
// `invalid` fail the step, and a failed step's outputs are never read.
export function decideOutputs(judged: VersionVerdict): string[] {
  if (judged.kind === "above" || judged.kind === "equal") {
    return [`unreleased=${judged.kind === "above"}`, `version=${judged.version}`];
  }
  return [];
}

// Actions hands the output file's path in GITHUB_OUTPUT and expects `key=value` lines appended to
// it; without the variable (a local run) the same lines go to stdout.
export function applyDecideMode(judged: VersionVerdict, githubOutputPath: string | undefined): number {
  console.log(judged.message);
  const lines = decideOutputs(judged);
  if (githubOutputPath === undefined) {
    for (const line of lines) console.log(line);
  } else if (lines.length > 0) {
    appendFileSync(githubOutputPath, `${lines.join("\n")}\n`);
  }
  return lines.length > 0 ? 0 : 1;
}

function applyStrictMode(judged: VersionVerdict): number {
  console.log(judged.message);
  return judged.passes ? 0 : 1;
}

function parseMode(argv: string[]): Mode {
  if (argv.length === 0) return "strict";
  if (argv.length === 1 && argv[0] === DECIDE_FLAG) return "decide";
  throw new Error(`unknown argument "${argv.join(" ")}": the only flag is ${DECIDE_FLAG}`);
}

export async function main(repoDir: string, argv: string[], githubOutputPath: string | undefined): Promise<number> {
  let mode: Mode;
  try {
    mode = parseMode(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  const latestTag = await latestReleaseTag(repoDir);
  if (mode === "decide" && latestTag === null) {
    console.error(NO_TAG_VISIBLE_MESSAGE);
    return 1;
  }
  const judged = judgeUnreleasedVersion(packageJson.version, latestTag);
  return mode === "decide" ? applyDecideMode(judged, githubOutputPath) : applyStrictMode(judged);
}

if (import.meta.main) {
  main(process.cwd(), process.argv.slice(2), process.env.GITHUB_OUTPUT).then((code) => {
    process.exitCode = code;
  });
}
