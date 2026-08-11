export const NOTE_TYPES = ["bugfix", "antipattern", "decision", "pattern"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

// Pattern and antipattern notes are generalized knowledge — "do this" / "don't do this" about a
// CLASS of situations — so their anchors are illustrative EXAMPLE links, not the address where the
// note applies. For these two types anchor staleness and the bundle anchor-overlap bonus are
// switched off (recall rides body semantics alone); bugfix and decision stay place-bound. Both call
// sites (index-db rebuild, memory-steps bundle) import this single predicate so the gates cannot drift.
export function isAnchorNeutral(type: NoteType): boolean {
  return type === "pattern" || type === "antipattern";
}

export type NoteFrontmatter = {
  id: string;
  type: NoteType;
  anchors: string[];
  // Concept strings (class names, domain terms, DB columns) — the note's TOPIC, not its address.
  // Tags feed FTS at rebuild and render to humans; git never checks them. Anchors stay paths only.
  tags?: string[];
  commit: string;
  created: string;
  supersedes?: string;
  // Lifecycle metadata, system-written at retire-accept (the supersedes precedent): the body stays
  // immutable, the file stays in notes/ as history, and rebuild derives exclusion from this flag.
  retired?: true;
};

export interface Note {
  frontmatter: NoteFrontmatter;
  body: string;
}

export class NoteValidationError extends Error {}

const ID_REGEX =
  /^(?:[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isNoteId(value: string): boolean {
  return ID_REGEX.test(value);
}
const COMMIT_REGEX = /^[0-9a-f]{7,40}$/;
const CREATED_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CONTROL_CHARACTERS_REGEX = /[\0\r\n]/;
export const MAX_BODY_CODE_POINTS = 1500;

const FRONTMATTER_FENCE = "---\n";
const FRONTMATTER_CLOSING = "\n---\n";
const KEY_VALUE_SEPARATOR = ": ";
const FRONTMATTER_KEYS = ["id", "type", "anchors", "tags", "commit", "created", "supersedes", "retired"] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(FRONTMATTER_KEYS);

export function serializeNote(note: Note): string {
  const frontmatter = validateFrontmatter(note.frontmatter);
  validateBody(note.body);
  const lines = [
    `id: ${JSON.stringify(frontmatter.id)}`,
    `type: ${JSON.stringify(frontmatter.type)}`,
    `anchors: ${JSON.stringify(frontmatter.anchors)}`,
  ];
  if (frontmatter.tags !== undefined) {
    lines.push(`tags: ${JSON.stringify(frontmatter.tags)}`);
  }
  lines.push(
    `commit: ${JSON.stringify(frontmatter.commit)}`,
    `created: ${JSON.stringify(frontmatter.created)}`,
  );
  if (frontmatter.supersedes !== undefined) {
    lines.push(`supersedes: ${JSON.stringify(frontmatter.supersedes)}`);
  }
  if (frontmatter.retired !== undefined) {
    lines.push("retired: true");
  }
  return `${FRONTMATTER_FENCE}${lines.join("\n")}${FRONTMATTER_CLOSING}${note.body}`;
}

export function parseNote(text: string): Note {
  if (!text.startsWith(FRONTMATTER_FENCE)) {
    throw new NoteValidationError("note is missing an opening frontmatter fence");
  }
  const afterOpening = text.slice(FRONTMATTER_FENCE.length);
  const closingIndex = afterOpening.indexOf(FRONTMATTER_CLOSING);
  if (closingIndex === -1) {
    throw new NoteValidationError("note is missing a closing frontmatter fence");
  }
  const block = afterOpening.slice(0, closingIndex);
  const body = afterOpening.slice(closingIndex + FRONTMATTER_CLOSING.length);
  const frontmatter = validateFrontmatter(parseFrontmatterBlock(block));
  validateBody(body);
  return { frontmatter, body };
}

function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const separatorIndex = line.indexOf(KEY_VALUE_SEPARATOR);
    if (separatorIndex === -1) {
      throw new NoteValidationError(`malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, separatorIndex);
    const rawValue = line.slice(separatorIndex + KEY_VALUE_SEPARATOR.length);
    parsed[key] = parseJsonValue(rawValue, key);
  }
  return parsed;
}

function parseJsonValue(rawValue: string, key: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new NoteValidationError(`frontmatter value for "${key}" is not valid JSON`);
  }
}

function validateFrontmatter(candidate: Record<string, unknown>): NoteFrontmatter {
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new NoteValidationError(`unknown frontmatter key: ${key}`);
    }
  }
  const frontmatter: NoteFrontmatter = {
    id: validateId(candidate.id),
    type: validateType(candidate.type),
    anchors: validateAnchors(candidate.anchors),
    commit: validateCommit(candidate.commit),
    created: validateCreated(candidate.created),
  };
  if (candidate.tags !== undefined) {
    frontmatter.tags = validateTags(candidate.tags);
  }
  if (frontmatter.anchors.length === 0 && frontmatter.tags === undefined) {
    throw new NoteValidationError("note must carry at least one anchor or one tag");
  }
  if (candidate.supersedes !== undefined) {
    frontmatter.supersedes = validateSupersedes(candidate.supersedes);
  }
  if (candidate.retired !== undefined) {
    frontmatter.retired = validateRetired(candidate.retired);
  }
  return frontmatter;
}

// Only the literal true is a valid marker: a "retired: false" key would be a second way to spell an
// un-retired note, so it is rejected instead of normalized.
function validateRetired(value: unknown): true {
  if (value !== true) {
    throw new NoteValidationError(`retired must be the literal true when present: ${String(value)}`);
  }
  return true;
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !isNoteId(value)) {
    throw new NoteValidationError(`id must be a ULID or UUID: ${String(value)}`);
  }
  return value;
}

function validateType(value: unknown): NoteType {
  if (typeof value !== "string" || !(NOTE_TYPES as readonly string[]).includes(value)) {
    throw new NoteValidationError(`type must be one of ${NOTE_TYPES.join(", ")}: ${String(value)}`);
  }
  return value as NoteType;
}

// Anchors may be empty ONLY when tags carry the note instead — the at-least-one-of-two rule is
// enforced after both fields are known, in validateFrontmatter.
function validateAnchors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new NoteValidationError("anchors must be an array");
  }
  return value.map(validateAnchor);
}

// Tags share the anchors' transport hygiene (no NUL/CR/LF) but none of the path restrictions:
// "Tickets::FindSimilarGroup", "ticket_groups.terminal_at" and spaced phrases are all legal.
// An empty tags array has exactly one spelling — omit the key — so [] is rejected, not normalized.
function validateTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NoteValidationError("tags must be a non-empty array when present");
  }
  const seen = new Set<string>();
  return value.map((tag) => {
    const validated = validateTag(tag);
    if (seen.has(validated)) {
      throw new NoteValidationError(`duplicate tag: ${validated}`);
    }
    seen.add(validated);
    return validated;
  });
}

function validateTag(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NoteValidationError("tag must be a non-empty string");
  }
  if (CONTROL_CHARACTERS_REGEX.test(value)) {
    throw new NoteValidationError("tag must not contain NUL, CR or LF");
  }
  return value;
}

export function validateAnchor(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NoteValidationError("anchor must be a non-empty string");
  }
  if (value.startsWith("/") || value.startsWith("-")) {
    throw new NoteValidationError(`anchor must be repository-relative: ${value}`);
  }
  if (value.startsWith(":")) {
    throw new NoteValidationError(`anchor must not start with a git pathspec sigil: ${value}`);
  }
  if (CONTROL_CHARACTERS_REGEX.test(value)) {
    throw new NoteValidationError("anchor must not contain NUL, CR or LF");
  }
  if (value.includes("\\")) {
    throw new NoteValidationError(`backslash is not allowed in an anchor: ${value}`);
  }
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "..") {
      throw new NoteValidationError(`anchor has an invalid path segment: ${value}`);
    }
  }
  return value;
}

function validateCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_REGEX.test(value)) {
    throw new NoteValidationError(`commit must be 7-40 lowercase hex characters: ${String(value)}`);
  }
  return value;
}

function validateCreated(value: unknown): string {
  if (typeof value !== "string" || !CREATED_REGEX.test(value)) {
    throw new NoteValidationError(`created must be an ISO-8601 UTC timestamp: ${String(value)}`);
  }
  return value;
}

function validateSupersedes(value: unknown): string {
  if (typeof value !== "string" || !isNoteId(value)) {
    throw new NoteValidationError(`supersedes must be a ULID or UUID: ${String(value)}`);
  }
  return value;
}

function validateBody(body: string): void {
  const codePointCount = [...body].length;
  if (codePointCount < 1 || codePointCount > MAX_BODY_CODE_POINTS) {
    throw new NoteValidationError(`body must be 1-${MAX_BODY_CODE_POINTS} code points`);
  }
  const newlineIndex = body.indexOf("\n");
  const firstLine = newlineIndex === -1 ? body : body.slice(0, newlineIndex);
  if (firstLine.trim().length === 0) {
    throw new NoteValidationError("body first line must be non-empty");
  }
}
