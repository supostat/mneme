import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit, initRepo } from "./git";
import { stalenessBoost, DEAD_ANCHOR_SINK, DRIFT_PENALTY_CAP } from "./staleness";

async function makeRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "mneme-staleness-"));
  await initRepo(repoDir);
  return repoDir;
}

async function commitFile(
  repoDir: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  mkdirSync(join(repoDir, dirname(path)), { recursive: true });
  writeFileSync(join(repoDir, path), content);
  const add = await runGit(repoDir, ["add"], [path]);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = await runGit(repoDir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return head(repoDir);
}

async function head(repoDir: string): Promise<string> {
  return (await runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("stalenessBoost live anchors", () => {
  test("a live, un-drifted anchor scores 0", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "src/live.ts", "v0", "add live");

    expect(await stalenessBoost(repoDir, ["src/live.ts"], commit)).toBe(0);
  });

  test("drift after the note commit accrues -0.001 per commit", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "src/live.ts", "v0", "add live");
    await commitFile(repoDir, "src/live.ts", "v1", "drift 1");
    await commitFile(repoDir, "src/live.ts", "v2", "drift 2");
    await commitFile(repoDir, "src/live.ts", "v3", "drift 3");

    expect(await stalenessBoost(repoDir, ["src/live.ts"], commit)).toBeCloseTo(-0.003, 6);
  });

  test("drift is floored at the cap beyond ten commits", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "src/live.ts", "v0", "add live");
    for (let index = 1; index <= 12; index++) {
      await commitFile(repoDir, "src/live.ts", `v${index}`, `drift ${index}`);
    }

    expect(await stalenessBoost(repoDir, ["src/live.ts"], commit)).toBe(DRIFT_PENALTY_CAP);
  });

  test("commits that do not touch the anchor do not accrue drift", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "src/live.ts", "v0", "add live");
    await commitFile(repoDir, "src/other.ts", "o1", "unrelated 1");
    await commitFile(repoDir, "src/other.ts", "o2", "unrelated 2");

    expect(await stalenessBoost(repoDir, ["src/live.ts"], commit)).toBe(0);
  });
});

describe("stalenessBoost dead anchors and robustness", () => {
  test("a note anchored to an untracked path sinks to the dead sink", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "src/live.ts", "v0", "add live");

    expect(await stalenessBoost(repoDir, ["src/ghost.ts"], commit)).toBe(DEAD_ANCHOR_SINK);
  });

  test("worst anchor wins: one live, one dead sinks the whole note", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "src/live.ts", "v0", "add live");

    expect(await stalenessBoost(repoDir, ["src/live.ts", "src/ghost.ts"], commit)).toBe(
      DEAD_ANCHOR_SINK,
    );
  });

  test("a missing repository yields the dead sink without throwing", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "mneme-norepo-"));
    writeFileSync(join(plainDir, "file.ts"), "content");

    expect(await stalenessBoost(plainDir, ["file.ts"], "abc1234")).toBe(DEAD_ANCHOR_SINK);
  });

  test("a live anchor with a rewritten/unknown commit yields the dead sink, not a throw", async () => {
    const repoDir = await makeRepo();
    await commitFile(repoDir, "src/live.ts", "v0", "add live");

    expect(
      await stalenessBoost(repoDir, ["src/live.ts"], "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    ).toBe(DEAD_ANCHOR_SINK);
  });

  test("an anchor beginning with a dash reaches git as a path, not a flag", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "-x", "v0", "add dashed path");

    expect(await stalenessBoost(repoDir, ["-x"], commit)).toBe(0);
  });
});
