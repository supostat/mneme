import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitIdentityReadError, commitIdentityOf, readLiveCommitIdentities } from "./commit-identity";
import { initRepo, runGit } from "./git";

// Real repositories throughout: what a rebase keeps and what a missing object does to the batch are
// git's answers, never a stand-in's.
setDefaultTimeout(30_000);

const AUTHOR = ["-c", "user.email=author@example.test", "-c", "user.name=author"];
const MISSING_FULL = "deadbeef".repeat(5);
const MISSING_SHORT = "abcdef1";

async function makeRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "mneme-commit-identity-"));
  await initRepo(repoDir);
  return repoDir;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await runGit(repoDir, [...AUTHOR, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commitFile(repoDir: string, path: string, subject: string, authorTime: number): Promise<string> {
  writeFileSync(join(repoDir, path), `${subject}\n`);
  await git(repoDir, ["add", "--", path]);
  await git(repoDir, ["commit", "-q", "-m", subject, `--date=@${authorTime} +0000`]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

describe("commitIdentityOf", () => {
  test("the v1 identity is a sha256 over the version, author time, author email and subject", () => {
    const canonical = "v1\u00001700000000\u0000author@example.test\u0000Split the ledger";
    const expected = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;

    expect(
      commitIdentityOf({ authorTime: "1700000000", authorEmail: "author@example.test", subject: "Split the ledger" }),
    ).toBe(expected);
  });

  test("each field of the authorship changes the identity", () => {
    const base = { authorTime: "1700000000", authorEmail: "author@example.test", subject: "Split the ledger" };
    const identity = commitIdentityOf(base);

    expect(commitIdentityOf({ ...base, authorTime: "1700000001" })).not.toBe(identity);
    expect(commitIdentityOf({ ...base, authorEmail: "other@example.test" })).not.toBe(identity);
    expect(commitIdentityOf({ ...base, subject: "Split the ledgers" })).not.toBe(identity);
  });
});

describe("readLiveCommitIdentities", () => {
  test("a live commit answers under its full sha with the identity of its authorship", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "a.ts", "Add the ledger", 1700000000);

    const identities = await readLiveCommitIdentities(repoDir, [commit]);

    expect([...identities]).toEqual([
      [commit, commitIdentityOf({ authorTime: "1700000000", authorEmail: "author@example.test", subject: "Add the ledger" })],
    ]);
  });

  test("a missing object in the batch is absent from the answer and does not fail the call", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "a.ts", "Add the ledger", 1700000000);

    const identities = await readLiveCommitIdentities(repoDir, [MISSING_FULL, commit, MISSING_SHORT]);

    expect([...identities.keys()]).toEqual([commit]);
  });

  test("an abbreviated commit answers under its full sha", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "a.ts", "Add the ledger", 1700000000);

    const identities = await readLiveCommitIdentities(repoDir, [commit.slice(0, 12)]);

    expect([...identities.keys()]).toEqual([commit]);
  });

  test("an empty request answers empty without asking git, even outside a repository", async () => {
    const notARepository = mkdtempSync(join(tmpdir(), "mneme-commit-identity-bare-"));

    expect(await readLiveCommitIdentities(notARepository, [])).toEqual(new Map());
  });

  test("a directory that is not a repository is a named error", async () => {
    const notARepository = mkdtempSync(join(tmpdir(), "mneme-commit-identity-bare-"));

    await expect(readLiveCommitIdentities(notARepository, [MISSING_FULL])).rejects.toThrow(CommitIdentityReadError);
  });

  test("a rebase rewrites the sha and keeps the identity", async () => {
    const repoDir = await makeRepo();
    await commitFile(repoDir, "base.ts", "Start the project", 1700000000);
    await git(repoDir, ["checkout", "-q", "-b", "feature"]);
    const original = await commitFile(repoDir, "ledger.ts", "Split the ledger", 1700000100);
    await git(repoDir, ["checkout", "-q", "main"]);
    await commitFile(repoDir, "main.ts", "Move main forward", 1700000200);
    await git(repoDir, ["checkout", "-q", "feature"]);
    await git(repoDir, ["rebase", "-q", "main"]);
    const copy = await git(repoDir, ["rev-parse", "HEAD"]);

    const identities = await readLiveCommitIdentities(repoDir, [original, copy]);

    expect(copy).not.toBe(original);
    expect(identities.get(copy)).toBe(identities.get(original)!);
    expect(identities.get(copy)).toBe(
      commitIdentityOf({ authorTime: "1700000100", authorEmail: "author@example.test", subject: "Split the ledger" }),
    );
  });
});
