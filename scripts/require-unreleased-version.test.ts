import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, runGit } from "../src/git";
import { compareSemver, judgeUnreleasedVersion, latestReleaseTag, parseSemver } from "./require-unreleased-version";

describe("judgeUnreleasedVersion", () => {
  test("a version above the latest tag passes", () => {
    const verdict = judgeUnreleasedVersion("0.1.8", "v0.1.7");

    expect(verdict.passes).toBe(true);
    expect(verdict.message).toContain("above the latest release tag v0.1.7");
  });

  test("a version equal to the latest tag fails with a raise-the-version reason", () => {
    const verdict = judgeUnreleasedVersion("0.1.7", "v0.1.7");

    expect(verdict.passes).toBe(false);
    expect(verdict.message).toContain("equals the latest release tag v0.1.7");
  });

  test("a version below the latest tag fails", () => {
    const verdict = judgeUnreleasedVersion("0.1.6", "v0.1.7");

    expect(verdict.passes).toBe(false);
    expect(verdict.message).toContain("below the latest release tag v0.1.7");
  });

  test("with no release tag at all any well-formed version passes", () => {
    const verdict = judgeUnreleasedVersion("0.0.1", null);

    expect(verdict.passes).toBe(true);
    expect(verdict.message).toContain("nothing was released yet");
  });

  test("a malformed version or tag fails with a named reason instead of a false pass", () => {
    expect(judgeUnreleasedVersion("0.1", "v0.1.7").passes).toBe(false);
    expect(judgeUnreleasedVersion("0.1.8", "v0.1.7-rc1").passes).toBe(false);
  });

  test("comparison is numeric per component, never lexical", () => {
    expect(parseSemver("v0.10.0")).toEqual([0, 10, 0]);
    expect(compareSemver([0, 10, 0], [0, 9, 9])).toBe(1);
    expect(compareSemver([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(compareSemver([0, 9, 9], [0, 10, 0])).toBe(-1);
  });
});

describe("latestReleaseTag", () => {
  async function makeRepo(): Promise<string> {
    const repoDir = mkdtempSync(join(tmpdir(), "mneme-release-tag-"));
    await initRepo(repoDir);
    await runGit(repoDir, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
    return repoDir;
  }

  test("returns null when the repository carries no v* tag", async () => {
    expect(await latestReleaseTag(await makeRepo())).toBeNull();
  });

  test("returns the highest v* tag by version order, ignoring other tags", async () => {
    const repoDir = await makeRepo();
    for (const tag of ["v0.9.0", "v0.10.0", "v0.2.0", "engine-v0.11.0"]) {
      await runGit(repoDir, ["tag", tag]);
    }

    expect(await latestReleaseTag(repoDir)).toBe("v0.10.0");
  });
});
