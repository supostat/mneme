#!/usr/bin/env bun
import packageJson from "../package.json";
import { runGit } from "../src/git";

// Release gate for a change that ships: release.yml publishes on a v<version> tag and refuses a tag
// that differs from package.json (requireTagMatchesVersion in build-release.ts), and NOTHING bumps
// the version automatically — so a shipping change must raise it by hand, and this script makes
// that forgettable step a machine check. Exit 0 when package.json is STRICTLY above the highest
// v* tag, exit 1 with a named reason otherwise. A repository with no v* tag has released nothing,
// so any version passes. The gate-runner spawns one argv without a shell, which is why this is a
// script and not a one-liner.

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TAG_GLOB = "v*";

export interface VersionVerdict {
  passes: boolean;
  message: string;
}

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

export function judgeUnreleasedVersion(version: string, latestTag: string | null): VersionVerdict {
  const parsedVersion = parseSemver(version);
  if (parsedVersion === null) {
    return { passes: false, message: `package.json version "${version}" is not a MAJOR.MINOR.PATCH version` };
  }
  if (latestTag === null) {
    return { passes: true, message: `version ${version} passes: no ${RELEASE_TAG_GLOB} tag exists, nothing was released yet` };
  }
  const parsedTag = parseSemver(latestTag);
  if (parsedTag === null) {
    return { passes: false, message: `latest release tag "${latestTag}" is not a v<MAJOR.MINOR.PATCH> tag` };
  }
  const order = compareSemver(parsedVersion, parsedTag);
  if (order > 0) {
    return { passes: true, message: `version ${version} is above the latest release tag ${latestTag}` };
  }
  if (order === 0) {
    return {
      passes: false,
      message: `version ${version} equals the latest release tag ${latestTag}: raise the version before shipping`,
    };
  }
  return { passes: false, message: `version ${version} is below the latest release tag ${latestTag}` };
}

export async function latestReleaseTag(repoDir: string): Promise<string | null> {
  const listed = await runGit(repoDir, ["tag", "--list", RELEASE_TAG_GLOB, "--sort=-v:refname"]);
  if (listed.exitCode !== 0) {
    throw new Error(`git failed to list release tags: ${listed.stderr.trim()}`);
  }
  const first = listed.stdout.split("\n")[0]?.trim() ?? "";
  return first === "" ? null : first;
}

export async function main(repoDir: string): Promise<number> {
  const verdict = judgeUnreleasedVersion(packageJson.version, await latestReleaseTag(repoDir));
  console.log(verdict.message);
  return verdict.passes ? 0 : 1;
}

if (import.meta.main) {
  main(process.cwd()).then((code) => {
    process.exitCode = code;
  });
}
