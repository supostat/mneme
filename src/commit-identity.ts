import { createHash } from "node:crypto";
import { runGitWithInput } from "./git";

// A commit's identity is what a rebase keeps when it rewrites the commit: the author's time, the
// author's email and the subject. It is stored hashed, so no text of the project's history enters
// the corpus; the version prefix lets the canonical form change without colliding with v1 values.

export const COMMIT_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

const IDENTITY_FORMAT_VERSION = "v1";
const FIELD_SEPARATOR = "\0";
const COMMIT_RECORD_FIELDS = 4;
const COMMIT_RECORD_FORMAT = "--format=%H%x00%at%x00%ae%x00%s";

export class CommitIdentityReadError extends Error {}

export interface CommitAuthorship {
  authorTime: string;
  authorEmail: string;
  subject: string;
}

export function commitIdentityOf(authorship: CommitAuthorship): string {
  const canonical = [IDENTITY_FORMAT_VERSION, authorship.authorTime, authorship.authorEmail, authorship.subject].join(
    FIELD_SEPARATOR,
  );
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// Full sha -> identity for every requested commit whose object this repository still holds; a
// missing object is simply absent from the answer. An abbreviated commit answers under its full sha.
export async function readLiveCommitIdentities(projectRoot: string, commits: string[]): Promise<Map<string, string>> {
  // `git log --stdin` given no revisions falls back to HEAD, so an empty request never reaches git.
  if (commits.length === 0) return new Map();
  const result = await runGitWithInput(
    projectRoot,
    ["log", "--no-walk", "--ignore-missing", "--no-show-signature", "--stdin", COMMIT_RECORD_FORMAT],
    `${commits.join("\n")}\n`,
  );
  if (result.exitCode !== 0) {
    throw new CommitIdentityReadError(
      `git could not read commit identities in ${projectRoot}: ${result.stderr.trim()}`,
    );
  }
  return new Map(
    result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map(parseCommitRecord),
  );
}

function parseCommitRecord(line: string): [string, string] {
  const fields = line.split(FIELD_SEPARATOR);
  if (fields.length !== COMMIT_RECORD_FIELDS) {
    throw new CommitIdentityReadError(`git printed a commit record of an unexpected shape: ${JSON.stringify(line)}`);
  }
  const [sha, authorTime, authorEmail, subject] = fields as [string, string, string, string];
  return [sha, commitIdentityOf({ authorTime, authorEmail, subject })];
}
