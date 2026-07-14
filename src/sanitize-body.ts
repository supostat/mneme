// Defense-in-depth on the WRITE path: reject a note body that carries FOREIGN tool/agent-protocol
// markup before it is ever staged. Fail-closed by design — a poisoned body raises a clear error and is
// never silently stripped, because silent mutation would corrupt the author's content and mask the
// attack. The set below is NARROW and curated: it targets memory-poisoning / framing vectors, NOT
// generic angle brackets, so legitimate code fragments (<div>, JSX, Array<string>, a < b) pass through.
//
// Framing-safety discipline: every dangerous token is assembled from harmless pieces at load time so
// this source file never itself contains a live tool-calling tag, MCP fence, or invisible framing char.

export class ForbiddenMarkupError extends Error {}

// Bare tag names only — the assembled "<" + name form is what would be dangerous, and it never appears
// as a literal here. Agent tool-calling framing tags are the tokens that could hijack tool dispatch if
// a recalled body ever escaped its fence; HTML document-skeleton tags are page/tool OUTPUT
// contamination (a note is about code fragments, never a whole document).
const FRAMING_TAG_NAMES = ["function_calls", "invoke", "parameter", "function_results"] as const;
const HARNESS_TAG_NAMES = ["system-reminder"] as const;
const HTML_SKELETON_TAG_NAMES = ["html", "head", "body"] as const;
const FORBIDDEN_TAG_NAMES = [...FRAMING_TAG_NAMES, ...HARNESS_TAG_NAMES, ...HTML_SKELETON_TAG_NAMES];

const TAG_OPEN = "<";
const OPTIONAL_CLOSING_SLASH = "/?";
const NAME_BOUNDARY = "\\b";
// Matches "<name" or "</name" only when the name follows the bracket immediately and ends on a word
// boundary. The boundary keeps <header>, <bodybuilder> and <invoked>-style fragments from matching.
const FORBIDDEN_TAG_PATTERN = new RegExp(
  TAG_OPEN + OPTIONAL_CLOSING_SLASH + "(?:" + FORBIDDEN_TAG_NAMES.join("|") + ")" + NAME_BOUNDARY,
  "i",
);

// The forgeable MCP note-fence delimiters (the delimiter-forgery class): a body containing them could
// impersonate the recall fence boundary. Plain substrings, no brackets — safe to keep as literals.
const FORBIDDEN_FENCE_LITERALS = ["BEGIN MNEME NOTE", "END MNEME NOTE"] as const;

// Characters that break MCP JSON-RPC line framing; built from code points so no raw invisible byte
// lands in this file.
const FRAMING_BREAKING_CODE_POINTS = [0x2028, 0x2029, 0x0085] as const;

function labelForCodePoint(codePoint: number): string {
  return "U+" + codePoint.toString(16).toUpperCase().padStart(4, "0");
}

function findForbiddenTag(body: string): string | null {
  const match = FORBIDDEN_TAG_PATTERN.exec(body);
  return match === null ? null : match[0];
}

function findForbiddenFence(body: string): string | null {
  const haystack = body.toLowerCase();
  for (const literal of FORBIDDEN_FENCE_LITERALS) {
    if (haystack.includes(literal.toLowerCase())) {
      return literal;
    }
  }
  return null;
}

function findFramingBreakingCharacter(body: string): string | null {
  for (const codePoint of FRAMING_BREAKING_CODE_POINTS) {
    if (body.includes(String.fromCharCode(codePoint))) {
      return labelForCodePoint(codePoint);
    }
  }
  return null;
}

// Returns the offending token (or a U+XXXX label for an invisible char) if the body carries foreign
// protocol markup, or null when the body is clean. Pure predicate: it never mutates the body.
export function findForbiddenMarkup(body: string): string | null {
  return findForbiddenTag(body) ?? findForbiddenFence(body) ?? findFramingBreakingCharacter(body);
}

// Fail-closed gate for the remember write path. Throws with the offending token named so the human
// sees exactly what was rejected; leaves a clean body untouched (validation only, never mutation).
export function assertCleanNoteBody(body: string): void {
  const forbidden = findForbiddenMarkup(body);
  if (forbidden !== null) {
    throw new ForbiddenMarkupError(
      `note body contains foreign tool/protocol markup and was rejected: ${forbidden}`,
    );
  }
}
