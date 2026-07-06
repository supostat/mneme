import { test, expect, describe } from "bun:test";
import { serializeNote, parseNote, isNoteId, NoteValidationError } from "./note";
import type { Note, NoteFrontmatter } from "./note";

const baseFrontmatter: NoteFrontmatter = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  type: "bugfix",
  anchors: ["src/git.ts"],
  commit: "abc1234",
  created: "2026-07-06T10:00:00.000Z",
};

function note(frontmatter: Partial<NoteFrontmatter>, body = "First line essence."): Note {
  return { frontmatter: { ...baseFrontmatter, ...frontmatter }, body };
}

function serializeWith(frontmatter: Partial<NoteFrontmatter>, body?: string): () => string {
  return () => serializeNote(note(frontmatter, body));
}

describe("note round-trip", () => {
  test("serialize then parse preserves a ULID note", () => {
    const original = note({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("serialize then parse preserves a UUID note", () => {
    const original = note({ id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("re-serialization is stable", () => {
    const text = serializeNote(note({}));
    expect(serializeNote(parseNote(text))).toBe(text);
  });

  test("multiple anchors round-trip", () => {
    const original = note({ anchors: ["src/git.ts", "src/corpus.ts", "src/note.ts"] });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("anchors with special characters round-trip", () => {
    const original = note({ anchors: ["src/a:b#c.ts"] });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("anchor segments containing but not equal to '..' round-trip", () => {
    const original = note({ anchors: ["..foo", "foo.."] });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("anchor with a single-dot segment round-trips", () => {
    const original = note({ anchors: ["src/./git.ts"] });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("created without fractional seconds round-trips", () => {
    const original = note({ created: "2026-07-06T10:00:00Z" });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });

  test("supersedes round-trips when present", () => {
    const original = note({ supersedes: "01BX5ZZKBKACTAV9WEVGEMMVRZ" });
    expect(parseNote(serializeNote(original))).toEqual(original);
  });
});

describe("note boundaries", () => {
  test("body of exactly 1500 code points is accepted", () => {
    expect(serializeWith({}, "a".repeat(1500))).not.toThrow();
  });

  test("commit of 7 and 40 hex characters is accepted", () => {
    expect(serializeWith({ commit: "a".repeat(7) })).not.toThrow();
    expect(serializeWith({ commit: "a".repeat(40) })).not.toThrow();
  });
});

describe("note frontmatter validation", () => {
  test("empty anchors array is rejected", () => {
    expect(serializeWith({ anchors: [] })).toThrow(NoteValidationError);
  });

  test("anchor with a leading dash is rejected", () => {
    expect(serializeWith({ anchors: ["-oops.ts"] })).toThrow(NoteValidationError);
  });

  test("anchor with a leading slash is rejected", () => {
    expect(serializeWith({ anchors: ["/absolute/path.ts"] })).toThrow(NoteValidationError);
  });

  test("anchor with a parent segment is rejected", () => {
    expect(serializeWith({ anchors: ["src/../etc/passwd"] })).toThrow(NoteValidationError);
  });

  test("anchor with a leading git pathspec sigil is rejected", () => {
    expect(serializeWith({ anchors: [":(exclude)src"] })).toThrow(NoteValidationError);
    expect(serializeWith({ anchors: [":/"] })).toThrow(NoteValidationError);
  });

  test("anchor with an empty segment is rejected", () => {
    expect(serializeWith({ anchors: ["src//git.ts"] })).toThrow(NoteValidationError);
  });

  test("anchor with a newline is rejected", () => {
    expect(serializeWith({ anchors: ["src/git.ts\nmalicious"] })).toThrow(NoteValidationError);
  });

  test("anchor with a NUL byte is rejected", () => {
    expect(serializeWith({ anchors: ["src/git\0.ts"] })).toThrow(NoteValidationError);
  });

  test("anchor with a backslash separator is rejected", () => {
    expect(serializeWith({ anchors: ["src\\x.ts"] })).toThrow(NoteValidationError);
  });

  test("anchor with a backslash parent segment is rejected", () => {
    expect(serializeWith({ anchors: ["..\\x"] })).toThrow(NoteValidationError);
  });

  test("commit shorter than 7 characters is rejected", () => {
    expect(serializeWith({ commit: "abc123" })).toThrow(NoteValidationError);
  });

  test("non-hex commit is rejected", () => {
    expect(serializeWith({ commit: "zzzzzzz" })).toThrow(NoteValidationError);
  });

  test("uppercase commit is rejected", () => {
    expect(serializeWith({ commit: "ABC1234" })).toThrow(NoteValidationError);
  });

  test("malformed id is rejected", () => {
    expect(serializeWith({ id: "not-a-valid-id" })).toThrow(NoteValidationError);
  });

  test("non-UTC created is rejected", () => {
    expect(serializeWith({ created: "2026-07-06T10:00:00+03:00" })).toThrow(NoteValidationError);
  });

  test("malformed supersedes is rejected", () => {
    expect(serializeWith({ supersedes: "nope" })).toThrow(NoteValidationError);
  });
});

describe("note body validation", () => {
  test("body over 1500 code points is rejected", () => {
    expect(serializeWith({}, "a".repeat(1501))).toThrow(NoteValidationError);
  });

  test("empty body is rejected", () => {
    expect(serializeWith({}, "")).toThrow(NoteValidationError);
  });

  test("blank first line is rejected", () => {
    expect(serializeWith({}, "\nsecond line has content")).toThrow(NoteValidationError);
  });
});

describe("isNoteId", () => {
  test("accepts a ULID", () => {
    expect(isNoteId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  test("accepts a lowercase UUIDv4", () => {
    expect(isNoteId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("rejects an uppercase UUID", () => {
    expect(isNoteId("550E8400-E29B-41D4-A716-446655440000")).toBe(false);
  });

  test("rejects a too-short id", () => {
    expect(isNoteId("01ARZ3NDEKTSV4RRFFQ69G5F")).toBe(false);
  });

  test("rejects garbage", () => {
    expect(isNoteId("not-an-id")).toBe(false);
    expect(isNoteId("")).toBe(false);
  });
});

describe("note parse validation", () => {
  const validBlock =
    'id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"\n' +
    'type: "bugfix"\n' +
    'anchors: ["src/git.ts"]\n' +
    'commit: "abc1234"\n' +
    'created: "2026-07-06T10:00:00.000Z"';

  test("unknown frontmatter key is rejected", () => {
    const text = `---\n${validBlock}\nfoo: "bar"\n---\nBody.`;
    expect(() => parseNote(text)).toThrow(NoteValidationError);
  });

  test("a fifth note type is rejected", () => {
    const text = `---\nid: "01ARZ3NDEKTSV4RRFFQ69G5FAV"\ntype: "speculation"\nanchors: ["src/git.ts"]\ncommit: "abc1234"\ncreated: "2026-07-06T10:00:00.000Z"\n---\nBody.`;
    expect(() => parseNote(text)).toThrow(NoteValidationError);
  });

  test("text without frontmatter fences is rejected", () => {
    expect(() => parseNote("just some prose")).toThrow(NoteValidationError);
  });

  test("unterminated frontmatter is rejected", () => {
    expect(() => parseNote(`---\n${validBlock}`)).toThrow(NoteValidationError);
  });
});
