import { describe, expect, test } from "bun:test";
import {
  FRONTMATTER_CLOSING,
  FRONTMATTER_FENCE,
  frontmatterLine,
  parseFrontmatterBlock,
  renderFrontmatterDocument,
  splitFrontmatter,
} from "./frontmatter";
import type { FrontmatterGrammar } from "./frontmatter";

// The grammar module raises every fault through the caller's factory, so the test pins both the
// error CLASS (the caller's own) and the MESSAGE (the subject noun woven in).
class FixtureError extends Error {}

const grammar: FrontmatterGrammar = {
  subject: "fixture",
  fail: (message) => new FixtureError(message),
};

describe("splitFrontmatter", () => {
  test("separates the block between the fences from the body after them", () => {
    const text = `${FRONTMATTER_FENCE}id: "a"\nkind: "domain"${FRONTMATTER_CLOSING}first line\nsecond line`;

    expect(splitFrontmatter(text, grammar)).toEqual({
      block: 'id: "a"\nkind: "domain"',
      body: "first line\nsecond line",
    });
  });

  test("an empty body after the closing fence is returned as the empty string", () => {
    expect(splitFrontmatter(`${FRONTMATTER_FENCE}id: "a"${FRONTMATTER_CLOSING}`, grammar).body).toBe("");
  });

  test("a document without an opening fence fails through the caller's factory", () => {
    expect(() => splitFrontmatter("just prose", grammar)).toThrow(FixtureError);
    expect(() => splitFrontmatter("just prose", grammar)).toThrow(
      "fixture is missing an opening frontmatter fence",
    );
  });

  test("a document without a closing fence fails through the caller's factory", () => {
    const text = `${FRONTMATTER_FENCE}id: "a"\nbody without closing`;

    expect(() => splitFrontmatter(text, grammar)).toThrow(FixtureError);
    expect(() => splitFrontmatter(text, grammar)).toThrow("fixture is missing a closing frontmatter fence");
  });
});

describe("parseFrontmatterBlock", () => {
  test("parses every line as key and JSON literal value", () => {
    const block = 'id: "a"\nanchors: ["src/a.ts","src/b.ts"]\nretired: true\ncount: 3';

    expect(parseFrontmatterBlock(block, grammar)).toEqual({
      id: "a",
      anchors: ["src/a.ts", "src/b.ts"],
      retired: true,
      count: 3,
    });
  });

  test("a line without the separator is malformed", () => {
    expect(() => parseFrontmatterBlock('id: "a"\nno separator here', grammar)).toThrow(FixtureError);
    expect(() => parseFrontmatterBlock('id: "a"\nno separator here', grammar)).toThrow(
      "malformed frontmatter line: no separator here",
    );
  });

  test("a value that is not JSON names its key", () => {
    expect(() => parseFrontmatterBlock("anchors: [unquoted]", grammar)).toThrow(FixtureError);
    expect(() => parseFrontmatterBlock("anchors: [unquoted]", grammar)).toThrow(
      'frontmatter value for "anchors" is not valid JSON',
    );
  });

  test("a later line may repeat a key; the last value wins, as in the historical note parser", () => {
    expect(parseFrontmatterBlock('id: "a"\nid: "b"', grammar)).toEqual({ id: "b" });
  });
});

describe("rendering", () => {
  test("frontmatterLine renders key, separator and the JSON literal", () => {
    expect(frontmatterLine("anchors", ["src/a.ts"])).toBe('anchors: ["src/a.ts"]');
    expect(frontmatterLine("retired", true)).toBe("retired: true");
  });

  test("a rendered document splits back into the same lines and body", () => {
    const lines = [frontmatterLine("id", "a"), frontmatterLine("terms", ["x", "y"])];
    const rendered = renderFrontmatterDocument(lines, "the body\nline two");

    expect(rendered).toBe(`---\nid: "a"\nterms: ["x","y"]\n---\nthe body\nline two`);
    expect(splitFrontmatter(rendered, grammar)).toEqual({
      block: 'id: "a"\nterms: ["x","y"]',
      body: "the body\nline two",
    });
  });
});
