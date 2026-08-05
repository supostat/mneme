import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit, initRepo } from "./git";
import { createLivenessContext, livenessOf, resolveAnchorLiveness } from "./anchor-liveness";
import type { LivenessContext } from "./anchor-liveness";

async function makeRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "mneme-liveness-"));
  await initRepo(repoDir);
  return repoDir;
}

async function commitFile(repoDir: string, path: string, content: string, message: string): Promise<void> {
  mkdirSync(join(repoDir, dirname(path)), { recursive: true });
  writeFileSync(join(repoDir, path), content);
  const add = await runGit(repoDir, ["add"], [path]);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = await runGit(repoDir, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message,
  ]);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

async function checkout(repoDir: string, args: string[]): Promise<void> {
  const result = await runGit(repoDir, ["checkout", "-q", ...args]);
  if (result.exitCode !== 0) throw new Error(`git checkout failed: ${result.stderr}`);
}

// main carries src/a.ts; branch "feature" additionally carries src/feature-only.ts; the worktree
// sits back on main, so feature-only.ts is absent from both the index and the disk.
async function repoWithParkedBranch(): Promise<string> {
  const repoDir = await makeRepo();
  await commitFile(repoDir, "src/a.ts", "on main", "init");
  await checkout(repoDir, ["-b", "feature"]);
  await commitFile(repoDir, "src/feature-only.ts", "parked on feature", "add feature file");
  await checkout(repoDir, ["main"]);
  return repoDir;
}

describe("four-state anchor liveness", () => {
  test("distinguishes tracked, untracked-exists, known-elsewhere (with branch names), and missing", async () => {
    const repoDir = await repoWithParkedBranch();
    writeFileSync(join(repoDir, "src/fresh.ts"), "created this session\n");

    const context = await createLivenessContext(repoDir);
    const anchors = await resolveAnchorLiveness(context, [
      "src/a.ts",
      "src/fresh.ts",
      "src/feature-only.ts",
      "src/ghost.ts",
    ]);

    expect(anchors).toEqual([
      { path: "src/a.ts", liveness: "tracked" },
      { path: "src/fresh.ts", liveness: "untracked-exists" },
      { path: "src/feature-only.ts", liveness: "known-elsewhere", branches: ["feature"] },
      { path: "src/ghost.ts", liveness: "missing" },
    ]);
  });

  test("a file on disk this session stays untracked-exists even when a branch tip also carries the path", async () => {
    const repoDir = await repoWithParkedBranch();
    // The same path exists uncommitted in the worktree: it is HERE, not "elsewhere".
    writeFileSync(join(repoDir, "src/feature-only.ts"), "local uncommitted copy\n");

    const context = await createLivenessContext(repoDir);
    const [anchor] = await resolveAnchorLiveness(context, ["src/feature-only.ts"]);

    expect(anchor!.liveness).toBe("untracked-exists");
  });

  test("a repository without branches yields an empty map and plain missing for unknown paths", async () => {
    const repoDir = await makeRepo();

    const context = await createLivenessContext(repoDir);

    expect(context.branchPaths.size).toBe(0);
    const [anchor] = await resolveAnchorLiveness(context, ["src/ghost.ts"]);
    expect(anchor!.liveness).toBe("missing");
  });
});

describe("liveness context is the single map source", () => {
  test("classification reads the CONTEXT map, never rebuilds it: a hand-built map decides known-elsewhere", async () => {
    // The repo has NO branch carrying this path; only the injected context map knows it. If the
    // classifier rebuilt the map internally, it would answer missing.
    const repoDir = await makeRepo();
    await commitFile(repoDir, "src/a.ts", "content", "init");
    const context: LivenessContext = {
      projectRoot: repoDir,
      branchPaths: new Map([["src/ghost.ts", ["imaginary-branch"]]]),
    };

    const anchor = await livenessOf(context, "src/ghost.ts");

    expect(anchor).toEqual({
      path: "src/ghost.ts",
      liveness: "known-elsewhere",
      branches: ["imaginary-branch"],
    });
  });
});
