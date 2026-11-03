import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveCommitIdentities } from "./commit-identity";
import {
  borrowCommitIdentities,
  CommitIdentityStoreError,
  planCommitIdentityCapture,
  readStoredCommitIdentities,
  writeCommitIdentityCapture,
} from "./commit-identity-store";
import type { CommitIdentityCaptureDeps } from "./commit-identity-store";
import { resolveCorpus } from "./corpus";
import { initRepo, runGit } from "./git";
import { writeMapSection } from "./map/map-store";
import { serializeNote } from "./note";

// A real project repository and a real corpus repository: what the store records comes from git's
// own objects, and what a write must commit is what the corpus's git does not track yet.
setDefaultTimeout(30_000);

const AUTHOR = ["-c", "user.email=t@t", "-c", "user.name=t"];
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GONE_COMMIT = "deadbeef".repeat(5);
const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function identityValue(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await runGit(repoDir, [...AUTHOR, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Bench {
  deps: CommitIdentityCaptureDeps;
  commits: string[];
}

// A project with `commitCount` commits, oldest first, and its fresh corpus.
async function makeBench(commitCount: number): Promise<Bench> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-identity-store-proj-"));
  await initRepo(projectRoot);
  const commits: string[] = [];
  for (let index = 0; index < commitCount; index++) {
    writeFileSync(join(projectRoot, "a.ts"), `version ${index}\n`);
    await git(projectRoot, ["add", "a.ts"]);
    await git(projectRoot, ["commit", "-q", "-m", `change ${index}`]);
    commits.push(await git(projectRoot, ["rev-parse", "HEAD"]));
  }
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-identity-store-home-"));
  const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
  return { deps: { corpus, projectRoot }, commits };
}

function writeNote(bench: Bench, n: number, commit: string): void {
  const id = ulid(n);
  writeFileSync(
    join(bench.deps.corpus.notesDir, `${id}.md`),
    serializeNote({
      frontmatter: { id, type: "decision", anchors: ["a.ts"], commit, created: "2026-07-06T10:00:00.000Z" },
      body: `decision number ${n}`,
    }),
  );
}

function writeStoredIdentity(bench: Bench, commit: string, identity: string): void {
  writeFileSync(join(bench.deps.corpus.commitIdentitiesDir, commit), `${identity}\n`);
}

async function commitCorpus(bench: Bench): Promise<void> {
  await git(bench.deps.corpus.corpusDir, ["add", "-A"]);
  await git(bench.deps.corpus.corpusDir, ["commit", "-q", "-m", "seed", "--allow-empty"]);
}

describe("readStoredCommitIdentities", () => {
  test("reads every stored identity under its full sha", async () => {
    const bench = await makeBench(2);
    writeStoredIdentity(bench, bench.commits[0]!, identityValue("a"));
    writeStoredIdentity(bench, bench.commits[1]!, identityValue("b"));

    const stored = readStoredCommitIdentities(bench.deps.corpus.commitIdentitiesDir);

    expect(stored).toEqual(
      new Map([
        [bench.commits[0]!, identityValue("a")],
        [bench.commits[1]!, identityValue("b")],
      ]),
    );
  });

  test("a corpus without the directory has recorded nothing", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "mneme-identity-store-old-")), "commit-identities");

    expect(readStoredCommitIdentities(missing)).toEqual(new Map());
  });

  test("a malformed identity is a named error carrying its path", async () => {
    const bench = await makeBench(1);
    const path = join(bench.deps.corpus.commitIdentitiesDir, bench.commits[0]!);
    writeFileSync(path, "not an identity\n");

    expect(() => readStoredCommitIdentities(bench.deps.corpus.commitIdentitiesDir)).toThrow(
      new CommitIdentityStoreError(`malformed commit identity — expected one sha256:<64 hex> line: ${path}`),
    );
  });

  test("a file not named by a full commit is a named error carrying its path", async () => {
    const bench = await makeBench(1);
    const path = join(bench.deps.corpus.commitIdentitiesDir, "abc1234");
    writeFileSync(path, `${identityValue("a")}\n`);

    expect(() => readStoredCommitIdentities(bench.deps.corpus.commitIdentitiesDir)).toThrow(
      new CommitIdentityStoreError(`not a commit identity file — the name must be a full 40-hex commit: ${path}`),
    );
  });

  test("a hidden file is not an entry", async () => {
    const bench = await makeBench(1);
    writeFileSync(join(bench.deps.corpus.commitIdentitiesDir, ".DS_Store"), "finder noise");

    expect(readStoredCommitIdentities(bench.deps.corpus.commitIdentitiesDir)).toEqual(new Map());
  });
});

describe("planCommitIdentityCapture", () => {
  test("the first capture plans every live commit the corpus pins: active notes, map sections and the incoming one", async () => {
    const bench = await makeBench(4);
    const [noteCommit, sharedCommit, sectionCommit, incomingCommit] = bench.commits as [string, string, string, string];
    writeNote(bench, 1, noteCommit);
    writeNote(bench, 2, sharedCommit);
    writeNote(bench, 3, sharedCommit);
    writeMapSection(bench.deps.corpus, {
      frontmatter: { id: "ledger", kind: "domain", anchors: ["a.ts"], depends_on: [], terms: [], commit: sectionCommit },
      body: "The ledger domain.",
    });

    const capture = await planCommitIdentityCapture(bench.deps, [incomingCommit]);

    const live = await readLiveCommitIdentities(bench.deps.projectRoot, bench.commits);
    expect(capture.identities).toEqual(live);
    expect([...capture.identities.keys()].sort()).toEqual([...bench.commits].sort());
  });

  test("a commit whose object is gone is not planned and does not fail the plan", async () => {
    const bench = await makeBench(1);
    writeNote(bench, 1, GONE_COMMIT);

    const capture = await planCommitIdentityCapture(bench.deps, [bench.commits[0]!]);

    expect([...capture.identities.keys()]).toEqual([bench.commits[0]!]);
  });

  test("a commit the store already holds is not planned again", async () => {
    const bench = await makeBench(2);
    writeNote(bench, 1, bench.commits[0]!);
    writeStoredIdentity(bench, bench.commits[0]!, identityValue("a"));

    const capture = await planCommitIdentityCapture(bench.deps, [bench.commits[1]!]);

    expect([...capture.identities.keys()]).toEqual([bench.commits[1]!]);
  });

  test("planning writes nothing", async () => {
    const bench = await makeBench(1);

    await planCommitIdentityCapture(bench.deps, [bench.commits[0]!]);

    expect(readdirSync(bench.deps.corpus.commitIdentitiesDir)).toEqual([]);
  });
});

describe("writeCommitIdentityCapture", () => {
  test("writes one identity line per planned commit and returns every untracked file: the written ones and an earlier write's tail", async () => {
    const bench = await makeBench(3);
    const [committedCommit, tailCommit, plannedCommit] = bench.commits as [string, string, string];
    writeStoredIdentity(bench, committedCommit, identityValue("a"));
    await commitCorpus(bench);
    writeStoredIdentity(bench, tailCommit, identityValue("b"));

    const paths = await writeCommitIdentityCapture(bench.deps.corpus, {
      identities: new Map([[plannedCommit, identityValue("c")]]),
    });

    expect(readFileSync(join(bench.deps.corpus.commitIdentitiesDir, plannedCommit), "utf8")).toBe(
      `${identityValue("c")}\n`,
    );
    expect(paths.sort()).toEqual([`commit-identities/${plannedCommit}`, `commit-identities/${tailCommit}`].sort());
  });

  test("an empty plan over a fully committed store returns no path", async () => {
    const bench = await makeBench(1);
    writeStoredIdentity(bench, bench.commits[0]!, identityValue("a"));
    await commitCorpus(bench);

    expect(await writeCommitIdentityCapture(bench.deps.corpus, { identities: new Map() })).toEqual([]);
  });
});

describe("borrowCommitIdentities", () => {
  test("borrows a lent identity only for the given commits and never over one the corpus holds", async () => {
    const bench = await makeBench(1);
    const held = bench.commits[0]!;
    const lentOnly = "1".repeat(40);
    const notAsked = "2".repeat(40);
    writeStoredIdentity(bench, held, identityValue("a"));
    const lender = new Map([
      [held, identityValue("b")],
      [lentOnly, identityValue("c")],
      [notAsked, identityValue("d")],
    ]);

    const capture = borrowCommitIdentities(
      { identities: new Map() },
      lender,
      [held, lentOnly],
      bench.deps.corpus.commitIdentitiesDir,
    );

    expect(capture.identities).toEqual(new Map([[lentOnly, identityValue("c")]]));
  });

  test("a live identity already planned wins over the lent one", async () => {
    const bench = await makeBench(1);
    const commit = bench.commits[0]!;

    const capture = borrowCommitIdentities(
      { identities: new Map([[commit, identityValue("a")]]) },
      new Map([[commit, identityValue("b")]]),
      [commit],
      bench.deps.corpus.commitIdentitiesDir,
    );

    expect(capture.identities).toEqual(new Map([[commit, identityValue("a")]]));
  });
});
