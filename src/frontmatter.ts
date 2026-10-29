// The frontmatter grammar shared by notes and map sections: a `---` fence, one `key: <JSON>` line
// per field, a closing fence, then the body. Each document type owns its field validation and its
// error class; this module only splits and parses, raising every fault through the caller's
// factory so a note keeps throwing NoteValidationError and a map section its own error — the
// two parsers cannot drift on the fence or the line shape because there is exactly one of each.

export const FRONTMATTER_FENCE = "---\n";
export const FRONTMATTER_CLOSING = "\n---\n";
export const KEY_VALUE_SEPARATOR = ": ";

export interface FrontmatterDocument {
  block: string;
  body: string;
}

export interface FrontmatterGrammar {
  // The document noun error messages name: "note", "map section".
  subject: string;
  fail: (message: string) => Error;
}

export function splitFrontmatter(text: string, grammar: FrontmatterGrammar): FrontmatterDocument {
  if (!text.startsWith(FRONTMATTER_FENCE)) {
    throw grammar.fail(`${grammar.subject} is missing an opening frontmatter fence`);
  }
  const afterOpening = text.slice(FRONTMATTER_FENCE.length);
  const closingIndex = afterOpening.indexOf(FRONTMATTER_CLOSING);
  if (closingIndex === -1) {
    throw grammar.fail(`${grammar.subject} is missing a closing frontmatter fence`);
  }
  return {
    block: afterOpening.slice(0, closingIndex),
    body: afterOpening.slice(closingIndex + FRONTMATTER_CLOSING.length),
  };
}

export function parseFrontmatterBlock(block: string, grammar: FrontmatterGrammar): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const separatorIndex = line.indexOf(KEY_VALUE_SEPARATOR);
    if (separatorIndex === -1) {
      throw grammar.fail(`malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, separatorIndex);
    const rawValue = line.slice(separatorIndex + KEY_VALUE_SEPARATOR.length);
    parsed[key] = parseJsonValue(rawValue, key, grammar);
  }
  return parsed;
}

function parseJsonValue(rawValue: string, key: string, grammar: FrontmatterGrammar): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw grammar.fail(`frontmatter value for "${key}" is not valid JSON`);
  }
}

export function frontmatterLine(key: string, value: unknown): string {
  return `${key}${KEY_VALUE_SEPARATOR}${JSON.stringify(value)}`;
}

export function renderFrontmatterDocument(lines: string[], body: string): string {
  return `${FRONTMATTER_FENCE}${lines.join("\n")}${FRONTMATTER_CLOSING}${body}`;
}
