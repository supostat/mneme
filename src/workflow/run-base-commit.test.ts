import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, runGit } from "../git";
import { resolveBaseCommit } from "./run-base-commit";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("resolveBaseCommit", () => {
  test("a repository with a commit answers its HEAD", async () => {
    const projectRoot = tempDir("mneme-base-commit-repo-");
    await initRepo(projectRoot);
    writeFileSync(join(projectRoot, "a.ts"), "content\n");
    await runGit(projectRoot, ["add", "."]);
    await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    const head = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();

    expect(await resolveBaseCommit(projectRoot)).toEqual({ kind: "commit", sha: head });
  });

  test("a repository without commits answers that it has none, not a failure", async () => {
    const projectRoot = tempDir("mneme-base-commit-unborn-");
    await initRepo(projectRoot);

    expect(await resolveBaseCommit(projectRoot)).toEqual({ kind: "no-commits" });
  });

  test("a directory git cannot read as a repository is a git error, never mistaken for no commits", async () => {
    expect(await resolveBaseCommit(tempDir("mneme-base-commit-plain-"))).toEqual({ kind: "git-error" });
  });
});
