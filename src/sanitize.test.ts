import { test, expect, describe } from "bun:test";
import { sanitizeToolErrorMessage, SANITIZED_MESSAGE_MAX_LENGTH } from "./sanitize";
import type { SanitizeContext } from "./sanitize";

const context: SanitizeContext = {
  homeDir: "/Users/tester",
  corpusDir: "/Users/tester/.mneme/-Users-tester-Projects-mneme",
};

describe("sanitizeToolErrorMessage redacts secrets and paths", () => {
  test("redacts a fake GitHub token by its known prefix", () => {
    const result = sanitizeToolErrorMessage("auth failed with ghp_FAKEfake0123DEADBEEF while pushing", context);
    expect(result).not.toContain("ghp_FAKEfake0123DEADBEEF");
    expect(result).toContain("<redacted>");
  });

  test("replaces an absolute path under the corpus dir with <corpus>", () => {
    const result = sanitizeToolErrorMessage(`cannot read ${context.corpusDir}/staging/n1.md`, context);
    expect(result).not.toContain(context.corpusDir);
    expect(result).toBe("cannot read <corpus>/staging/n1.md");
  });

  test("replaces the home dir with ~ for a path outside the corpus", () => {
    expect(sanitizeToolErrorMessage(`missing ${context.homeDir}/notes.txt`, context)).toBe("missing ~/notes.txt");
  });

  test("strips URL userinfo but keeps the host", () => {
    const result = sanitizeToolErrorMessage("clone failed for https://user:tok@host/repo.git", context);
    expect(result).toBe("clone failed for https://host/repo.git");
  });

  test("redacts a key=value secret", () => {
    expect(sanitizeToolErrorMessage("request rejected: token=abc123 invalid", context)).toBe(
      "request rejected: token=<redacted> invalid",
    );
  });

  test("redacts a fake token and rewrites absolute paths in the same message", () => {
    const result = sanitizeToolErrorMessage(
      `auth with ghp_FAKEfake0123DEADBEEF failed writing ${context.corpusDir}/staging/n1.md, log at ${context.homeDir}/mneme.log`,
      context,
    );
    expect(result).toBe("auth with <redacted> failed writing <corpus>/staging/n1.md, log at ~/mneme.log");
  });
});

describe("sanitizeToolErrorMessage is narrow by design", () => {
  test("leaves a plain message unchanged", () => {
    const message = "supersede target does not exist in notes";
    expect(sanitizeToolErrorMessage(message, context)).toBe(message);
  });

  test("does not redact a bare ULID", () => {
    const message = "supersede target does not exist in notes: 01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(sanitizeToolErrorMessage(message, context)).toBe(message);
  });

  test("does not redact a 40-hex commit hash", () => {
    const message = "commit 1234567890abcdef1234567890abcdef12345678 not found";
    expect(sanitizeToolErrorMessage(message, context)).toBe(message);
  });
});

describe("sanitizeToolErrorMessage length cap", () => {
  test("truncates at the cap and appends a single ellipsis", () => {
    const long = "x".repeat(SANITIZED_MESSAGE_MAX_LENGTH + 50);
    const result = sanitizeToolErrorMessage(long, context);
    expect(result.length).toBe(SANITIZED_MESSAGE_MAX_LENGTH + 1);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, SANITIZED_MESSAGE_MAX_LENGTH)).toBe("x".repeat(SANITIZED_MESSAGE_MAX_LENGTH));
  });
});
