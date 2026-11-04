import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommitBases } from "./commit-base";
import { commitIdentityOf } from "./commit-identity";
import {
  planCommitIdentityCapture,
  readStoredCommitIdentities,
  writeCommitIdentityCapture,
} from "./commit-identity-store";
import { resolveCorpus } from "./corpus";
import { initRepo, runGit } from "./git";
import { serializeNote } from "./note";

// Real repositories and real rebases, real garbage collection: whether a commit is on HEAD, has a
// copy there, or is gone is exactly what git answers, so nothing here stands in for it.
setDefaultTimeout(30_000);

const AUTHOR_EMAIL = "author@example.test";
const AUTHOR = ["-c", `user.email=${AUTHOR_EMAIL}`, "-c", "user.name=author"];
const GONE_COMMIT = "deadbeef".repeat(5);
const NOTE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await runGit(repoDir, [...AUTHOR, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function makeRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "mneme-commit-base-"));
  await initRepo(repoDir);
  return repoDir;
}

async function commitFile(repoDir: string, path: string, subject: string, authorTime: number): Promise<string> {
  writeFileSync(join(repoDir, path), `${subject} ${authorTime} ${path}\n`);
  await git(repoDir, ["add", "--", path]);
  await git(repoDir, ["commit", "-q", "-m", subject, `--date=@${authorTime} +0000`]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

interface RebasedRepo {
  repoDir: string;
  original: string;
  copy: string;
}

// main starts the project; feature commits X; main moves forward; feature is rebased onto main, so
// X is rewritten into a copy on HEAD while X itself stays alive until a gc.
async function rebasedRepo(): Promise<RebasedRepo> {
  const repoDir = await makeRepo();
  await commitFile(repoDir, "base.ts", "Start the project", 1700000000);
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  const original = await commitFile(repoDir, "ledger.ts", "Split the ledger", 1700000100);
  await git(repoDir, ["checkout", "-q", "main"]);
  await commitFile(repoDir, "main.ts", "Move main forward", 1700000200);
  await git(repoDir, ["checkout", "-q", "feature"]);
  await git(repoDir, ["rebase", "-q", "main"]);
  return { repoDir, original, copy: await git(repoDir, ["rev-parse", "HEAD"]) };
}

async function collectGarbage(repoDir: string, commit: string): Promise<void> {
  await git(repoDir, ["reflog", "expire", "--expire-unreachable=now", "--all"]);
  await git(repoDir, ["gc", "-q", "--prune=now"]);
  const probe = await runGit(repoDir, ["cat-file", "-e", commit]);
  if (probe.exitCode === 0) throw new Error(`gc left ${commit} alive`);
}

describe("resolveCommitBases", () => {
  test("a commit in HEAD's history is on-head", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "a.ts", "Add a", 1700000000);

    const bases = await resolveCommitBases(repoDir, [commit], new Map());

    expect(bases).toEqual(new Map([[commit, { kind: "on-head", commit }]]));
  });

  test("an identity the real capture stored finds the one copy on HEAD after gc removed the original", async () => {
    const { repoDir, original, copy } = await rebasedRepo();
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-commit-base-home-"));
    const corpus = await resolveCorpus(repoDir, { corpusHome, clock: () => new Date("2026-07-06T10:00:00.000Z") });
    writeFileSync(
      join(corpus.notesDir, `${NOTE_ID}.md`),
      serializeNote({
        frontmatter: { id: NOTE_ID, type: "decision", anchors: ["ledger.ts"], commit: original, created: "2026-07-06T10:00:00.000Z" },
        body: "the ledger split decision",
      }),
    );
    await writeCommitIdentityCapture(corpus, await planCommitIdentityCapture({ corpus, projectRoot: repoDir }, []));
    await collectGarbage(repoDir, original);

    const bases = await resolveCommitBases(repoDir, [original], readStoredCommitIdentities(corpus.commitIdentitiesDir));

    expect(bases).toEqual(new Map([[original, { kind: "copy", commit: copy }]]));
  });

  test("a live object answers the identity when the store holds none", async () => {
    const { repoDir, original, copy } = await rebasedRepo();

    const bases = await resolveCommitBases(repoDir, [original], new Map());

    expect(bases).toEqual(new Map([[original, { kind: "copy", commit: copy }]]));
  });

  test("two commits on HEAD with the identity are no copy: a gone commit is unresolved, a live one off-head", async () => {
    const repoDir = await makeRepo();
    await commitFile(repoDir, "one.ts", "Same subject", 1700000000);
    await commitFile(repoDir, "two.ts", "Same subject", 1700000000);
    await git(repoDir, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    const liveTwin = await commitFile(repoDir, "three.ts", "Same subject", 1700000000);
    await git(repoDir, ["checkout", "-q", "main"]);
    const identity = commitIdentityOf({ authorTime: "1700000000", authorEmail: AUTHOR_EMAIL, subject: "Same subject" });

    const bases = await resolveCommitBases(repoDir, [GONE_COMMIT, liveTwin], new Map([[GONE_COMMIT, identity]]));

    expect(bases).toEqual(
      new Map([
        [GONE_COMMIT, { kind: "unresolved" }],
        [liveTwin, { kind: "off-head", commit: liveTwin }],
      ]),
    );
  });

  test("a live commit with no copy on HEAD is off-head", async () => {
    const repoDir = await makeRepo();
    await commitFile(repoDir, "a.ts", "Add a", 1700000000);
    await git(repoDir, ["checkout", "-q", "-b", "parallel"]);
    const parallel = await commitFile(repoDir, "p.ts", "Parallel change", 1700000100);
    await git(repoDir, ["checkout", "-q", "main"]);

    const bases = await resolveCommitBases(repoDir, [parallel], new Map());

    expect(bases).toEqual(new Map([[parallel, { kind: "off-head", commit: parallel }]]));
  });

  test("a gone commit with no stored identity is unresolved, even though its copy is on HEAD", async () => {
    const { repoDir, original } = await rebasedRepo();
    await collectGarbage(repoDir, original);

    const bases = await resolveCommitBases(repoDir, [original], new Map());

    expect(bases).toEqual(new Map([[original, { kind: "unresolved" }]]));
  });

  test("an abbreviated commit resolves by its unique prefix", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "a.ts", "Add a", 1700000000);
    const abbreviated = commit.slice(0, 12);

    const bases = await resolveCommitBases(repoDir, [abbreviated], new Map());

    expect(bases).toEqual(new Map([[abbreviated, { kind: "on-head", commit: abbreviated }]]));
  });

  test("a directory that is not a repository leaves every commit unresolved", async () => {
    const notARepository = mkdtempSync(join(tmpdir(), "mneme-commit-base-bare-"));

    const bases = await resolveCommitBases(notARepository, [GONE_COMMIT, "abc1234"], new Map());

    expect(bases).toEqual(
      new Map([
        [GONE_COMMIT, { kind: "unresolved" }],
        ["abc1234", { kind: "unresolved" }],
      ]),
    );
  });

  test("the same commit asked twice is resolved once under its own string", async () => {
    const repoDir = await makeRepo();
    const commit = await commitFile(repoDir, "a.ts", "Add a", 1700000000);

    const bases = await resolveCommitBases(repoDir, [commit, commit], new Map());

    expect([...bases.keys()]).toEqual([commit]);
  });
});
