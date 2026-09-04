import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, runGit } from "../src/git";
import {
  applyDecideMode,
  compareSemver,
  decideOutputs,
  judgeUnreleasedVersion,
  latestReleaseTag,
  main,
  parseSemver,
} from "./require-unreleased-version";

describe("judgeUnreleasedVersion", () => {
  test("a version above the latest tag passes", () => {
    const verdict = judgeUnreleasedVersion("0.1.8", "v0.1.7");

    expect(verdict.kind).toBe("above");
    expect(verdict.passes).toBe(true);
    expect(verdict.version).toBe("0.1.8");
    expect(verdict.message).toContain("above the latest release tag v0.1.7");
  });

  test("a version equal to the latest tag fails with a raise-the-version reason", () => {
    const verdict = judgeUnreleasedVersion("0.1.7", "v0.1.7");

    expect(verdict.kind).toBe("equal");
    expect(verdict.passes).toBe(false);
    expect(verdict.message).toContain("equals the latest release tag v0.1.7");
  });

  test("a version below the latest tag fails", () => {
    const verdict = judgeUnreleasedVersion("0.1.6", "v0.1.7");

    expect(verdict.kind).toBe("below");
    expect(verdict.passes).toBe(false);
    expect(verdict.message).toContain("below the latest release tag v0.1.7");
  });

  test("with no release tag at all any well-formed version passes", () => {
    const verdict = judgeUnreleasedVersion("0.0.1", null);

    expect(verdict.kind).toBe("above");
    expect(verdict.passes).toBe(true);
    expect(verdict.message).toContain("nothing was released yet");
  });

  test("a malformed version or tag fails with a named reason instead of a false pass", () => {
    const malformedVersion = judgeUnreleasedVersion("0.1", "v0.1.7");
    const malformedTag = judgeUnreleasedVersion("0.1.8", "v0.1.7-rc1");

    expect(malformedVersion.kind).toBe("invalid");
    expect(malformedVersion.passes).toBe(false);
    expect(malformedTag.kind).toBe("invalid");
    expect(malformedTag.passes).toBe(false);
  });

  test("comparison is numeric per component, never lexical", () => {
    expect(parseSemver("v0.10.0")).toEqual([0, 10, 0]);
    expect(compareSemver([0, 10, 0], [0, 9, 9])).toBe(1);
    expect(compareSemver([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(compareSemver([0, 9, 9], [0, 10, 0])).toBe(-1);
  });
});

describe("decide mode", () => {
  function outputFile(): string {
    const path = join(mkdtempSync(join(tmpdir(), "mneme-github-output-")), "output");
    // Actions pre-creates the file and other steps may have written to it already: appending must
    // keep what is there.
    writeFileSync(path, "earlier=kept\n");
    return path;
  }

  test("above: exit 0 and unreleased=true with the version, appended to GITHUB_OUTPUT", () => {
    const path = outputFile();

    const code = applyDecideMode(judgeUnreleasedVersion("0.1.8", "v0.1.7"), path);

    expect(code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("earlier=kept\nunreleased=true\nversion=0.1.8\n");
  });

  test("equal: exit 0 and unreleased=false — a re-push of a released version is a quiet no-op", () => {
    const path = outputFile();

    const code = applyDecideMode(judgeUnreleasedVersion("0.1.7", "v0.1.7"), path);

    expect(code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("earlier=kept\nunreleased=false\nversion=0.1.7\n");
  });

  test("below: exit 1 and no outputs", () => {
    const path = outputFile();

    const code = applyDecideMode(judgeUnreleasedVersion("0.1.6", "v0.1.7"), path);

    expect(code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("earlier=kept\n");
  });

  test("invalid: exit 1 and no outputs", () => {
    const path = outputFile();

    const code = applyDecideMode(judgeUnreleasedVersion("0.1", "v0.1.7"), path);

    expect(code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("earlier=kept\n");
  });

  test("without GITHUB_OUTPUT the outputs are not written anywhere on disk", () => {
    expect(decideOutputs(judgeUnreleasedVersion("0.1.8", "v0.1.7"))).toEqual(["unreleased=true", "version=0.1.8"]);
    expect(applyDecideMode(judgeUnreleasedVersion("0.1.8", "v0.1.7"), undefined)).toBe(0);
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

  test("main refuses an unknown flag with a named message before touching git", async () => {
    const original = console.error;
    const messages: string[] = [];
    console.error = (message: string) => {
      messages.push(message);
    };
    try {
      expect(await main(await makeRepo(), ["--bogus"])).toBe(1);
    } finally {
      console.error = original;
    }
    expect(messages).toEqual(['unknown argument "--bogus": the only flag is --decide']);
  });
});
