import {
  frontmatterLine,
  parseFrontmatterBlock,
  renderFrontmatterDocument,
  splitFrontmatter,
} from "../frontmatter";
import type { FrontmatterGrammar } from "../frontmatter";
import { TOKEN_BYTES } from "../fusion";
import { NoteValidationError, validateAnchor } from "../note";
import { assertCleanNoteBody, findForbiddenMarkup } from "../sanitize-body";

// A map section is the plugin-built synthetic layer over the note corpus: a DOMAIN describes one
// area of the project, a FLOW one path across domains. Sections share the notes' frontmatter
// grammar and anchor rules and nothing else — their own id grammar, their own body limit, their
// own error class — so no note function ever branches on "is this a section".

export const MAP_SECTION_KINDS = ["domain", "flow"] as const;
export type MapSectionKind = (typeof MAP_SECTION_KINDS)[number];

// The same grammar as a corpus name — a slug that becomes a file name under map/<kind>s/, so
// traversal is impossible by construction — but its own constant: section ids and corpus names
// are different things and must stay free to diverge.
export const MAP_SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECTION_ID_REQUIREMENT =
  "it must be a map section slug: lowercase letters, digits, underscore or dash, " +
  "starting with a letter or digit, at most 64 characters";

export function isMapSectionId(value: string): boolean {
  return MAP_SECTION_ID_PATTERN.test(value);
}

// Twice a note. A section is a synthesis over several notes' worth of material.
export const MAX_SECTION_CODE_POINTS = 3000;

// A glossary is a list of words, not prose: recall prints a section's terms whole, one per line
// after its body, so their count and length are capped like the body itself.
export const MAX_SECTION_TERMS = 24;
export const MAX_TERM_CODE_POINTS = 32;

// Sections are not charged to the notes budget at all, so everything recall prints of one — the
// body plus every term on its own line — is bounded by these constants alone, and the cap of two
// sections per recall bounds the rest. The token estimate is bytes / TOKEN_BYTES.
const PRINTED_SECTION_CODE_POINTS = MAX_SECTION_CODE_POINTS + MAX_SECTION_TERMS * (MAX_TERM_CODE_POINTS + 1);
const CYRILLIC_BYTES_PER_CODE_POINT = 2;
const MAX_ASCII_SECTION_TOKENS = Math.ceil(PRINTED_SECTION_CODE_POINTS / TOKEN_BYTES);
export const MAX_CYRILLIC_SECTION_TOKENS = Math.ceil(
  (PRINTED_SECTION_CODE_POINTS * CYRILLIC_BYTES_PER_CODE_POINT) / TOKEN_BYTES,
);
export const MAP_SECTION_LIMIT_RULE =
  `a map section body must fit ${MAX_SECTION_CODE_POINTS} code points — twice a note — and its terms at most ` +
  `${MAX_SECTION_TERMS} of ${MAX_TERM_CODE_POINTS} code points each; one section prints at most ` +
  `≈${MAX_ASCII_SECTION_TOKENS} tokens in ASCII (≈${MAX_CYRILLIC_SECTION_TOKENS} in Cyrillic) outside the notes ` +
  `budget, and at most 2 sections ride one recall`;

export type MapSectionFrontmatter = {
  id: string;
  kind: MapSectionKind;
  // Repository-relative paths, the note anchor grammar: the section's address in the code, the
  // key notes attach by, and what liveness ranks. May be empty — a section without a code address
  // takes the neutral staleness pin, exactly like a tags-only note.
  anchors: string[];
  // Ids of the sections this one builds on; a flow names the domains it crosses. Always written,
  // possibly empty. Existence of the targets is a map-level property (dangling dependencies are
  // reported), never a parse-time rule, so sections can be written in any order.
  depends_on: string[];
  // Glossary terms: a domain's terms become glossary rows and feed FTS; a flow's terms feed FTS only.
  terms: string[];
  // The project HEAD at the time the section was stored — the drift base for staleness.
  commit: string;
};

export interface MapSection {
  frontmatter: MapSectionFrontmatter;
  body: string;
}

export class MapSectionValidationError extends Error {}

const SECTION_GRAMMAR: FrontmatterGrammar = {
  subject: "map section",
  fail: (message) => new MapSectionValidationError(message),
};
const FRONTMATTER_KEYS = ["id", "kind", "anchors", "depends_on", "terms", "commit"] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(FRONTMATTER_KEYS);
const COMMIT_REGEX = /^[0-9a-f]{7,40}$/;
const CONTROL_CHARACTERS_REGEX = /[\0\r\n]/;

export function serializeMapSection(section: MapSection): string {
  const frontmatter = validateFrontmatter(section.frontmatter);
  validateBody(section.body);
  return renderFrontmatterDocument(
    FRONTMATTER_KEYS.map((key) => frontmatterLine(key, frontmatter[key])),
    section.body,
  );
}

export function parseMapSection(text: string): MapSection {
  const { block, body } = splitFrontmatter(text, SECTION_GRAMMAR);
  const frontmatter = validateFrontmatter(parseFrontmatterBlock(block, SECTION_GRAMMAR));
  validateBody(body);
  return { frontmatter, body };
}

// Every key is required and no other key is allowed: a section has exactly one spelling, so an
// empty depends_on or terms is written as [] rather than omitted (the retired:false precedent in
// reverse — one way to say "none").
function validateFrontmatter(candidate: Record<string, unknown>): MapSectionFrontmatter {
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new MapSectionValidationError(`unknown frontmatter key: ${key}`);
    }
  }
  for (const key of FRONTMATTER_KEYS) {
    if (!(key in candidate)) {
      throw new MapSectionValidationError(`missing frontmatter key: ${key}`);
    }
  }
  const id = validateId(candidate.id);
  return {
    id,
    kind: validateKind(candidate.kind),
    anchors: validateAnchors(candidate.anchors),
    depends_on: validateDependencies(candidate.depends_on, id),
    terms: validateTerms(candidate.terms),
    commit: validateCommit(candidate.commit),
  };
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !isMapSectionId(value)) {
    throw new MapSectionValidationError(`id is ${JSON.stringify(value)}; ${SECTION_ID_REQUIREMENT}`);
  }
  return value;
}

function validateKind(value: unknown): MapSectionKind {
  if (typeof value !== "string" || !(MAP_SECTION_KINDS as readonly string[]).includes(value)) {
    throw new MapSectionValidationError(`kind must be one of ${MAP_SECTION_KINDS.join(", ")}: ${String(value)}`);
  }
  return value as MapSectionKind;
}

// The note anchor grammar, re-raised as a section error: one path rule for the whole corpus, one
// error class per document type.
function validateAnchors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new MapSectionValidationError("anchors must be an array");
  }
  return value.map((anchor) => {
    try {
      return validateAnchor(anchor);
    } catch (error) {
      if (error instanceof NoteValidationError) {
        throw new MapSectionValidationError(error.message);
      }
      throw error;
    }
  });
}

function validateDependencies(value: unknown, ownId: string): string[] {
  if (!Array.isArray(value)) {
    throw new MapSectionValidationError("depends_on must be an array");
  }
  const seen = new Set<string>();
  return value.map((dependency) => {
    if (typeof dependency !== "string" || !isMapSectionId(dependency)) {
      throw new MapSectionValidationError(
        `depends_on entry is ${JSON.stringify(dependency)}; ${SECTION_ID_REQUIREMENT}`,
      );
    }
    if (dependency === ownId) {
      throw new MapSectionValidationError(`a section cannot depend on itself: ${dependency}`);
    }
    if (seen.has(dependency)) {
      throw new MapSectionValidationError(`duplicate depends_on entry: ${dependency}`);
    }
    seen.add(dependency);
    return dependency;
  });
}

// Terms share the tags' transport hygiene (no NUL/CR/LF) and none of the path restrictions. Each is
// printed on its own line inside the section's MAP block, so it passes the body's curator set too:
// a term that could forge a fence line is refused like a body that could. A refused term is named
// by its position, never echoed — it may be arbitrarily long.
function validateTerms(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new MapSectionValidationError("terms must be an array");
  }
  if (value.length > MAX_SECTION_TERMS) {
    throw new MapSectionValidationError(`a section holds at most ${MAX_SECTION_TERMS} terms: got ${value.length}`);
  }
  const seen = new Set<string>();
  return value.map((term, index) => {
    const position = index + 1;
    if (typeof term !== "string" || term.length === 0) {
      throw new MapSectionValidationError("term must be a non-empty string");
    }
    if ([...term].length > MAX_TERM_CODE_POINTS) {
      throw new MapSectionValidationError(`term ${position} must be at most ${MAX_TERM_CODE_POINTS} code points`);
    }
    if (CONTROL_CHARACTERS_REGEX.test(term)) {
      throw new MapSectionValidationError("term must not contain NUL, CR or LF");
    }
    const forbidden = findForbiddenMarkup(term);
    if (forbidden !== null) {
      throw new MapSectionValidationError(
        `term ${position} contains foreign tool/protocol markup and was rejected: ${forbidden}`,
      );
    }
    if (seen.has(term)) {
      throw new MapSectionValidationError(`duplicate term: ${term}`);
    }
    seen.add(term);
    return term;
  });
}

function validateCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_REGEX.test(value)) {
    throw new MapSectionValidationError(`commit must be 7-40 lowercase hex characters: ${String(value)}`);
  }
  return value;
}

// The first line is the section's essence — INDEX.md lists domains by it — so it must carry text.
// The write-path curator set applies to sections exactly as to notes: a body that could forge a
// fence or a protocol frame is refused with the token named, never stripped.
function validateBody(body: string): void {
  const codePointCount = [...body].length;
  if (codePointCount < 1 || codePointCount > MAX_SECTION_CODE_POINTS) {
    throw new MapSectionValidationError(`body must be 1-${MAX_SECTION_CODE_POINTS} code points`);
  }
  const newlineIndex = body.indexOf("\n");
  const firstLine = newlineIndex === -1 ? body : body.slice(0, newlineIndex);
  if (firstLine.trim().length === 0) {
    throw new MapSectionValidationError("body first line must be non-empty");
  }
  assertCleanNoteBody(body);
}
