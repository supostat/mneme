import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, isRepo, initRepo, GIT_PROCESS_LIMIT, gitProcessLimit } from "./git";

// Long enough for `git --version` to finish many times over had runGit spawned it anyway.
const UNSPAWNED_WAIT_MS = 250;

function makeTempRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "mneme-git-"));
  return initRepo(repoDir).then(() => repoDir);
}

function heldSlot(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held: gitProcessLimit.run(() => gate), release };
}

describe("git adapter hardening", () => {
  test("stripped GIT_* env does not leak into repoDir operations", async () => {
    const repoDir = await makeTempRepo();
    writeFileSync(join(repoDir, "planted-marker.txt"), "content");
    const foreignRepo = await makeTempRepo();

    process.env.GIT_DIR = join(foreignRepo, ".git");
    process.env.GIT_WORK_TREE = foreignRepo;
    process.env.GIT_INDEX_FILE = join(foreignRepo, "planted-index");
    try {
      expect(await isRepo(repoDir)).toBe(true);
      const status = await runGit(repoDir, ["status", "--porcelain"]);
      expect(status.stdout).toContain("planted-marker.txt");
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      delete process.env.GIT_INDEX_FILE;
    }
  });

  test("GIT_CONFIG_* injection and extended GIT_* keys are stripped from invocations", async () => {
    const repoDir = await makeTempRepo();

    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "inject.marker";
    process.env.GIT_CONFIG_VALUE_0 = "leaked";
    process.env.GIT_OBJECT_DIRECTORY = join(tmpdir(), "nonexistent-objects");
    try {
      const injected = await runGit(repoDir, ["config", "--get", "inject.marker"]);
      expect(injected.stdout.trim()).toBe("");
      expect(injected.exitCode).not.toBe(0);

      expect(await isRepo(repoDir)).toBe(true);
      const gitDir = await runGit(repoDir, ["rev-parse", "--git-dir"]);
      expect(gitDir.exitCode).toBe(0);
      expect(gitDir.stdout.trim()).toBe(".git");
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
      delete process.env.GIT_OBJECT_DIRECTORY;
    }
  });

  test("a pathArg after -- is treated literally, not as a flag", async () => {
    const repoDir = await makeTempRepo();
    writeFileSync(join(repoDir, "-x"), "content");

    const add = await runGit(repoDir, ["add"], ["-x"]);
    expect(add.exitCode).toBe(0);

    const staged = await runGit(repoDir, ["diff", "--cached", "--name-only"]);
    expect(staged.stdout.trim()).toBe("-x");
  });

  test("isRepo is false for a non-repository directory", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "mneme-plain-"));
    expect(await isRepo(plainDir)).toBe(false);
  });

  test("isRepo is true at the repo root but false in a nested subdirectory", async () => {
    const repoDir = await makeTempRepo();
    const nestedDir = join(repoDir, "sub");
    mkdirSync(nestedDir);

    expect(await isRepo(repoDir)).toBe(true);
    expect(await isRepo(nestedDir)).toBe(false);
  });

  test("initRepo rejects when the target path cannot be initialized", async () => {
    const base = mkdtempSync(join(tmpdir(), "mneme-noinit-"));
    const unreachablePath = join(base, "missing-parent", "child");

    await expect(initRepo(unreachablePath)).rejects.toThrow();
  });
});

describe("git process limit", () => {
  test("every git child shares one limit of 16", () => {
    expect(GIT_PROCESS_LIMIT).toBe(16);
  });

  test("runGit spawns nothing while every slot is held and runs as soon as one frees", async () => {
    const repoDir = await makeTempRepo();
    const slots = Array.from({ length: GIT_PROCESS_LIMIT }, () => heldSlot());
    try {
      let settled = false;
      const version = runGit(repoDir, ["--version"]).then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, UNSPAWNED_WAIT_MS));
      expect(settled).toBe(false);

      slots[0]!.release();
      const result = await version;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith("git version");
    } finally {
      for (const slot of slots) slot.release();
      await Promise.all(slots.map((slot) => slot.held));
    }
  });
});
