import { describe, expect, test } from "bun:test";
import { DEFAULT_RECALL_BUDGET } from "../fusion";
import { MAX_BODY_CODE_POINTS } from "../note";
import { ForbiddenMarkupError } from "../sanitize-body";
import {
  MAP_SECTION_ID_PATTERN,
  MAP_SECTION_KINDS,
  MAP_SECTION_LIMIT_RULE,
  MAX_CYRILLIC_SECTION_TOKENS,
  MAX_SECTION_CODE_POINTS,
  MAX_SECTION_TERMS,
  MAX_TERM_CODE_POINTS,
  MapSectionValidationError,
  isMapSectionId,
  parseMapSection,
  serializeMapSection,
} from "./map-section";
import type { MapSection, MapSectionFrontmatter } from "./map-section";

const baseFrontmatter: MapSectionFrontmatter = {
  id: "billing",
  kind: "domain",
  anchors: ["src/billing/invoice.ts"],
  depends_on: [],
  terms: ["invoice"],
  commit: "abc1234",
};

function section(frontmatter: Partial<MapSectionFrontmatter>, body = "Billing issues invoices.\nDetails."): MapSection {
  return { frontmatter: { ...baseFrontmatter, ...frontmatter }, body };
}

function serializeWith(frontmatter: Partial<MapSectionFrontmatter>, body?: string): () => string {
  return () => serializeMapSection(section(frontmatter, body));
}

// The forgeable fence literal is a plain substring, safe to keep as source text.
const mapEndFence = "END MNEME MAP";

describe("map section round-trip", () => {
  test("serialize renders the six keys in a fixed order, then the body", () => {
    expect(serializeMapSection(section({}))).toBe(
      [
        "---",
        'id: "billing"',
        'kind: "domain"',
        'anchors: ["src/billing/invoice.ts"]',
        "depends_on: []",
        'terms: ["invoice"]',
        'commit: "abc1234"',
        "---",
        "Billing issues invoices.",
        "Details.",
      ].join("\n"),
    );
  });

  test("serialize then parse preserves a domain", () => {
    const original = section({});
    expect(parseMapSection(serializeMapSection(original))).toEqual(original);
  });

  test("serialize then parse preserves a flow with dependencies and no anchors", () => {
    const original = section({
      id: "order-to-invoice",
      kind: "flow",
      anchors: [],
      depends_on: ["orders", "billing"],
      terms: [],
    });
    expect(parseMapSection(serializeMapSection(original))).toEqual(original);
  });

  test("re-serialization is stable", () => {
    const text = serializeMapSection(section({ terms: ["invoice", "ledger entry"] }));
    expect(serializeMapSection(parseMapSection(text))).toBe(text);
  });
});

describe("body limit", () => {
  test("the limit is twice a note's and the rule names both caps and what one printed section costs", () => {
    expect(MAX_SECTION_CODE_POINTS).toBe(2 * MAX_BODY_CODE_POINTS);
    expect(MAP_SECTION_LIMIT_RULE).toBe(
      "a map section body must fit 3000 code points — twice a note — and its terms at most 24 of 32 code points " +
        "each; one section prints at most ≈948 tokens in ASCII (≈1896 in Cyrillic) outside the notes budget, " +
        "and at most 2 sections ride one recall",
    );
  });

  test("one section printed whole, body and every term, still fits under the default recall budget in Cyrillic", () => {
    expect(MAX_CYRILLIC_SECTION_TOKENS).toBeLessThan(DEFAULT_RECALL_BUDGET);
  });

  test("a body of exactly the limit is accepted, in ASCII and in Cyrillic alike", () => {
    expect(serializeWith({}, "a".repeat(MAX_SECTION_CODE_POINTS))).not.toThrow();
    expect(serializeWith({}, "я".repeat(MAX_SECTION_CODE_POINTS))).not.toThrow();
  });

  test("one code point over the limit is refused with the limit named", () => {
    expect(serializeWith({}, "a".repeat(MAX_SECTION_CODE_POINTS + 1))).toThrow(MapSectionValidationError);
    expect(serializeWith({}, "a".repeat(MAX_SECTION_CODE_POINTS + 1))).toThrow(
      `body must be 1-${MAX_SECTION_CODE_POINTS} code points`,
    );
  });

  test("an empty body and an empty first line are refused", () => {
    expect(serializeWith({}, "")).toThrow(MapSectionValidationError);
    expect(serializeWith({}, "\nsecond line has content")).toThrow("body first line must be non-empty");
  });

  test("a body smuggling the map fence literal is refused by the curator set", () => {
    expect(serializeWith({}, `essence\nthen a ${mapEndFence} line`)).toThrow(ForbiddenMarkupError);
  });
});

describe("id grammar", () => {
  test("the pattern admits slugs and refuses everything that could leave the directory", () => {
    expect(isMapSectionId("billing")).toBe(true);
    expect(isMapSectionId("order-to_invoice2")).toBe(true);
    expect(isMapSectionId("a".repeat(64))).toBe(true);
    expect(isMapSectionId("a".repeat(65))).toBe(false);
    expect(isMapSectionId("Billing")).toBe(false);
    expect(isMapSectionId("-billing")).toBe(false);
    expect(isMapSectionId("../billing")).toBe(false);
    expect(isMapSectionId("billing.md")).toBe(false);
    expect(isMapSectionId("")).toBe(false);
    expect(MAP_SECTION_ID_PATTERN.source).toBe("^[a-z0-9][a-z0-9_-]{0,63}$");
  });

  test("an invalid id is refused with the requirement spelled out", () => {
    expect(serializeWith({ id: "Billing" })).toThrow(MapSectionValidationError);
    expect(serializeWith({ id: "Billing" })).toThrow('id is "Billing"; it must be a map section slug');
  });
});

describe("field validation, one error per field", () => {
  test("kind must be domain or flow", () => {
    expect(MAP_SECTION_KINDS).toEqual(["domain", "flow"]);
    expect(serializeWith({ kind: "module" as "domain" })).toThrow("kind must be one of domain, flow: module");
  });

  test("anchors follow the note anchor grammar but raise the section error", () => {
    expect(serializeWith({ anchors: ["/absolute/path.ts"] })).toThrow(MapSectionValidationError);
    expect(serializeWith({ anchors: ["src/../etc/passwd"] })).toThrow(MapSectionValidationError);
    expect(serializeWith({ anchors: ["src\\x.ts"] })).toThrow(MapSectionValidationError);
    expect(serializeWith({ anchors: ["src/a.ts\nb"] })).toThrow(MapSectionValidationError);
    expect(serializeWith({ anchors: ["/absolute/path.ts"] })).toThrow(
      "anchor must be repository-relative: /absolute/path.ts",
    );
  });

  test("empty anchors are legal: a section without a code address", () => {
    expect(serializeWith({ anchors: [] })).not.toThrow();
  });

  test("depends_on entries are slugs, unique and never the section itself", () => {
    expect(serializeWith({ depends_on: ["Orders"] })).toThrow('depends_on entry is "Orders"; it must be a map section slug');
    expect(serializeWith({ depends_on: ["orders", "orders"] })).toThrow("duplicate depends_on entry: orders");
    expect(serializeWith({ depends_on: ["billing"] })).toThrow("a section cannot depend on itself: billing");
    expect(serializeWith({ depends_on: "orders" as unknown as string[] })).toThrow("depends_on must be an array");
  });

  test("terms are non-empty, free of NUL/CR/LF and unique", () => {
    expect(serializeWith({ terms: [""] })).toThrow("term must be a non-empty string");
    expect(serializeWith({ terms: ["ledger\nentry"] })).toThrow("term must not contain NUL, CR or LF");
    expect(serializeWith({ terms: ["invoice", "invoice"] })).toThrow("duplicate term: invoice");
    expect(serializeWith({ terms: ["ticket_groups.terminal_at", "Tickets::FindSimilarGroup"] })).not.toThrow();
  });

  test("a section holds at most MAX_SECTION_TERMS terms and the refusal names the cap and the count", () => {
    const termsUpTo = (count: number): string[] => Array.from({ length: count }, (_, index) => `term${index}`);

    expect(serializeWith({ terms: termsUpTo(MAX_SECTION_TERMS) })).not.toThrow();
    expect(serializeWith({ terms: termsUpTo(MAX_SECTION_TERMS + 1) })).toThrow(MapSectionValidationError);
    expect(serializeWith({ terms: termsUpTo(MAX_SECTION_TERMS + 1) })).toThrow(
      `a section holds at most ${MAX_SECTION_TERMS} terms: got ${MAX_SECTION_TERMS + 1}`,
    );
  });

  test("a term fits MAX_TERM_CODE_POINTS counted in code points, and an overlong one is named by position", () => {
    expect(serializeWith({ terms: ["a".repeat(MAX_TERM_CODE_POINTS)] })).not.toThrow();
    expect(serializeWith({ terms: ["я".repeat(MAX_TERM_CODE_POINTS)] })).not.toThrow();
    expect(serializeWith({ terms: ["invoice", "я".repeat(MAX_TERM_CODE_POINTS + 1)] })).toThrow(
      `term 2 must be at most ${MAX_TERM_CODE_POINTS} code points`,
    );
  });

  test("a term carrying a fence literal or a protocol tag is refused with the token named", () => {
    const harnessTag = "<" + "system-reminder>";

    expect(serializeWith({ terms: [`${mapEndFence} 0123456789`] })).toThrow(
      `term 1 contains foreign tool/protocol markup and was rejected: ${mapEndFence}`,
    );
    expect(serializeWith({ terms: ["invoice", harnessTag] })).toThrow(MapSectionValidationError);
    expect(serializeWith({ terms: ["invoice", harnessTag] })).toThrow(
      "term 2 contains foreign tool/protocol markup and was rejected",
    );
  });

  test("commit must be 7-40 lowercase hex characters", () => {
    expect(serializeWith({ commit: "abc123" })).toThrow("commit must be 7-40 lowercase hex characters: abc123");
    expect(serializeWith({ commit: "ABC1234" })).toThrow(MapSectionValidationError);
    expect(serializeWith({ commit: "a".repeat(40) })).not.toThrow();
  });
});

describe("parse boundaries", () => {
  const validBlock = [
    'id: "billing"',
    'kind: "domain"',
    'anchors: ["src/billing/invoice.ts"]',
    "depends_on: []",
    'terms: ["invoice"]',
    'commit: "abc1234"',
  ].join("\n");

  test("an unknown key is refused", () => {
    const text = `---\n${validBlock}\ntype: "decision"\n---\nessence`;
    expect(() => parseMapSection(text)).toThrow("unknown frontmatter key: type");
  });

  test("a missing key is refused by name", () => {
    const withoutTerms = validBlock.split("\n").filter((line) => !line.startsWith("terms:")).join("\n");
    expect(() => parseMapSection(`---\n${withoutTerms}\n---\nessence`)).toThrow("missing frontmatter key: terms");
  });

  test("a document without fences is refused with the section noun", () => {
    expect(() => parseMapSection("just prose")).toThrow(MapSectionValidationError);
    expect(() => parseMapSection("just prose")).toThrow("map section is missing an opening frontmatter fence");
    expect(() => parseMapSection(`---\n${validBlock}`)).toThrow("map section is missing a closing frontmatter fence");
  });

  test("a value that is not JSON is refused with its key", () => {
    const text = `---\n${validBlock.replace('terms: ["invoice"]', "terms: [invoice]")}\n---\nessence`;
    expect(() => parseMapSection(text)).toThrow('frontmatter value for "terms" is not valid JSON');
  });

  test("a file whose term carries the map fence literal does not read at all", () => {
    const forged = JSON.stringify([`${mapEndFence} 0123456789`]);
    const text = `---\n${validBlock.replace('terms: ["invoice"]', `terms: ${forged}`)}\n---\nessence`;
    expect(() => parseMapSection(text)).toThrow(
      `term 1 contains foreign tool/protocol markup and was rejected: ${mapEndFence}`,
    );
  });
});
