import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, runGit } from "../git";
import { branchExists, isAnchorableBranchName, resolveCurrentBranch } from "./run-branch";

async function commitAll(projectRoot: string, message: string): Promise<void> {
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message,
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
}

async function buildRepoWithCommit(): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-run-branch-"));
  await initRepo(projectRoot);
  writeFileSync(join(projectRoot, "a.txt"), "content\n");
  await commitAll(projectRoot, "init");
  return projectRoot;
}

function nonRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "mneme-run-branch-norepo-"));
}

describe("resolveCurrentBranch", () => {
  test("a repo on its default branch resolves to that branch name", async () => {
    const projectRoot = await buildRepoWithCommit();

    expect(await resolveCurrentBranch(projectRoot)).toEqual({ kind: "branch", name: "main" });
  });

  test("a freshly checked-out branch resolves to the new name", async () => {
    const projectRoot = await buildRepoWithCommit();
    await runGit(projectRoot, ["checkout", "-q", "-b", "feature"]);

    expect(await resolveCurrentBranch(projectRoot)).toEqual({ kind: "branch", name: "feature" });
  });

  test("a detached HEAD resolves to detached, never a branch", async () => {
    const projectRoot = await buildRepoWithCommit();
    await runGit(projectRoot, ["checkout", "-q", "--detach"]);

    expect(await resolveCurrentBranch(projectRoot)).toEqual({ kind: "detached" });
  });

  test("a directory that is not a repository resolves to git-error", async () => {
    expect(await resolveCurrentBranch(nonRepoDir())).toEqual({ kind: "git-error" });
  });

  test("a checked-out branch carrying a line separator resolves to git-error, never a branch", async () => {
    const projectRoot = await buildRepoWithCommit();
    const separatorBranch = `feat${String.fromCodePoint(0x2028)}x`;
    const created = await runGit(projectRoot, ["checkout", "-q", "-b", separatorBranch]);
    if (created.exitCode !== 0) throw new Error(created.stderr);

    expect(await resolveCurrentBranch(projectRoot)).toEqual({ kind: "git-error" });
  });
});

describe("isAnchorableBranchName", () => {
  test("a plain branch name is anchorable", () => {
    expect(isAnchorableBranchName("feature/clean-name")).toBe(true);
  });

  test("names carrying U+0085, U+2028 or U+2029 are not anchorable", () => {
    for (const codePoint of [0x0085, 0x2028, 0x2029]) {
      expect(isAnchorableBranchName(`feat${String.fromCodePoint(codePoint)}x`)).toBe(false);
    }
  });
});

describe("branchExists", () => {
  test("an existing branch reads as exists", async () => {
    const projectRoot = await buildRepoWithCommit();

    expect(await branchExists(projectRoot, "main")).toBe("exists");
  });

  test("a never-created branch reads as missing", async () => {
    const projectRoot = await buildRepoWithCommit();

    expect(await branchExists(projectRoot, "gone")).toBe("missing");
  });

  test("a deleted branch reads as missing", async () => {
    const projectRoot = await buildRepoWithCommit();
    await runGit(projectRoot, ["branch", "feature"]);
    await runGit(projectRoot, ["branch", "-D", "feature"]);

    expect(await branchExists(projectRoot, "feature")).toBe("missing");
  });

  test("a directory that is not a repository reads as indeterminate, never missing", async () => {
    expect(await branchExists(nonRepoDir(), "main")).toBe("indeterminate");
  });
});
