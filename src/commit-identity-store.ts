import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveNotes } from "./active-notes";
import { readLiveCommitIdentities } from "./commit-identity";
import { COMMIT_IDENTITIES_DIRECTORY } from "./corpus";
import type { Corpus } from "./corpus";
import { trackedPaths } from "./corpus-git";
import { readMapSections } from "./map/map-store";

// The corpus-side record of commit identities: one file per project commit, named by its full sha,
// holding one `sha256:<hex>` line. It is written by every corpus write that pins a commit and is
// never rewritten — an identity is a fact about a commit object, so a second write of the same
// commit writes the same bytes. Capture is split into a plan (git reads only) and a write, so a
// failing git read refuses the operation before it touches the disk.

export class CommitIdentityStoreError extends Error {}

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const STORED_IDENTITY_PATTERN = /^(sha256:[0-9a-f]{64})\n$/;

export interface CommitIdentityCaptureDeps {
  corpus: Corpus;
  projectRoot: string;
}

export interface CommitIdentityCapture {
  identities: ReadonlyMap<string, string>;
}

// A corpus written before the store existed has no directory: it has recorded no identities yet.
export function readStoredCommitIdentities(commitIdentitiesDir: string): Map<string, string> {
  const identities = new Map<string, string>();
  for (const name of identityFileNames(commitIdentitiesDir)) {
    const path = join(commitIdentitiesDir, name);
    if (!FULL_COMMIT_PATTERN.test(name)) {
      throw new CommitIdentityStoreError(`not a commit identity file — the name must be a full 40-hex commit: ${path}`);
    }
    const match = STORED_IDENTITY_PATTERN.exec(readFileSync(path, "utf8"));
    if (match === null) {
      throw new CommitIdentityStoreError(`malformed commit identity — expected one sha256:<64 hex> line: ${path}`);
    }
    identities.set(name, match[1]!);
  }
  return identities;
}

// Every commit the corpus pins — active notes, map sections and the documents the operation is
// about to write — that the store does not hold yet, read from the live objects in one git call.
// A commit whose object is gone is not captured and is asked again on the next write.
export async function planCommitIdentityCapture(
  deps: CommitIdentityCaptureDeps,
  incomingCommits: string[],
): Promise<CommitIdentityCapture> {
  const stored = readStoredCommitIdentities(deps.corpus.commitIdentitiesDir);
  const pinned = new Set([...pinnedCommits(deps.corpus), ...incomingCommits]);
  const unrecorded = [...pinned].filter((commit) => !stored.has(commit));
  const live = await readLiveCommitIdentities(deps.projectRoot, unrecorded);
  return { identities: new Map([...live].filter(([commit]) => !stored.has(commit))) };
}

// Identities another corpus recorded for commits whose objects this repository cannot read, taken
// for the given commits only and never over an identity this corpus already holds.
export function borrowCommitIdentities(
  capture: CommitIdentityCapture,
  lender: ReadonlyMap<string, string>,
  commits: string[],
  commitIdentitiesDir: string,
): CommitIdentityCapture {
  const stored = readStoredCommitIdentities(commitIdentitiesDir);
  const identities = new Map(capture.identities);
  for (const commit of commits) {
    const lent = lender.get(commit);
    if (lent !== undefined && !identities.has(commit) && !stored.has(commit)) {
      identities.set(commit, lent);
    }
  }
  return { identities };
}

// Writes the planned files and returns the corpus-relative paths the operation must commit: every
// identity file on disk the corpus repository does not track yet. That is the files just written
// plus the tail of an earlier write whose commit failed, which this commit carries into history.
export async function writeCommitIdentityCapture(corpus: Corpus, capture: CommitIdentityCapture): Promise<string[]> {
  for (const [commit, identity] of capture.identities) {
    writeFileSync(join(corpus.commitIdentitiesDir, commit), `${identity}\n`);
  }
  const onDisk = identityFileNames(corpus.commitIdentitiesDir).map(
    (name) => `${COMMIT_IDENTITIES_DIRECTORY}/${name}`,
  );
  if (onDisk.length === 0) return [];
  const tracked = await trackedPaths(corpus, [COMMIT_IDENTITIES_DIRECTORY]);
  return onDisk.filter((path) => !tracked.has(path));
}

function pinnedCommits(corpus: Corpus): string[] {
  return [
    ...readActiveNotes(corpus.notesDir).map((note) => note.frontmatter.commit),
    ...readMapSections(corpus).map((section) => section.frontmatter.commit),
  ];
}

// Hidden files (an editor's or the OS's, such as .DS_Store) are never store entries.
function identityFileNames(commitIdentitiesDir: string): string[] {
  if (!existsSync(commitIdentitiesDir)) return [];
  return readdirSync(commitIdentitiesDir)
    .filter((name) => !name.startsWith("."))
    .sort();
}
