import {
  AGENT_JUDGED_MARKER,
  BULLET_PREFIX,
  COMMAND_FENCE,
  DONE_WHEN_HEADER,
  PhaseDocumentValidationError,
  SECTION_HEADER_PREFIX,
  TASKS_HEADER,
  validatePhaseDocument,
} from "./phase-document-schema";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document-schema";

export {
  MAX_PHASE_ID_LENGTH,
  PHASE_ID_REGEX,
  PhaseDocumentValidationError,
  containsForbiddenCharacter,
  isPhaseId,
} from "./phase-document-schema";
export type {
  DoneWhenCriterion,
  ExecutableCriterion,
  PhaseDocument,
} from "./phase-document-schema";

const FRONTMATTER_FENCE = "---\n";
const FRONTMATTER_CLOSING = "\n---\n";
const KEY_VALUE_SEPARATOR = ": ";
const REQUIRED_FRONTMATTER_KEYS = ["id", "deps", "agent-role"] as const;
const ALLOWED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(REQUIRED_FRONTMATTER_KEYS);

export function serializePhaseDocument(document: PhaseDocument): string {
  const validated = validatePhaseDocument(document);
  const lines = [
    "---",
    `id: ${JSON.stringify(validated.id)}`,
    `deps: ${JSON.stringify(validated.deps)}`,
    `agent-role: ${JSON.stringify(validated.agentRole)}`,
    "---",
  ];
  if (validated.description !== "") {
    lines.push(...validated.description.split("\n"), "");
  }
  lines.push(TASKS_HEADER);
  for (const task of validated.tasks) {
    lines.push(`${BULLET_PREFIX}${task}`);
  }
  lines.push("", DONE_WHEN_HEADER);
  for (const criterion of validated.doneWhen) {
    if (criterion.kind === "agent-judged") {
      lines.push(`${BULLET_PREFIX}${criterion.description}`, AGENT_JUDGED_MARKER);
    } else {
      lines.push(
        `${BULLET_PREFIX}${criterion.description}`,
        COMMAND_FENCE,
        criterion.command,
        COMMAND_FENCE,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parsePhaseDocument(text: string): PhaseDocument {
  if (!text.startsWith(FRONTMATTER_FENCE)) {
    throw new PhaseDocumentValidationError(
      "phase document is missing an opening frontmatter fence",
    );
  }
  const afterOpening = text.slice(FRONTMATTER_FENCE.length);
  const closingIndex = afterOpening.indexOf(FRONTMATTER_CLOSING);
  if (closingIndex === -1) {
    throw new PhaseDocumentValidationError("phase document is missing a closing frontmatter fence");
  }
  const frontmatter = parseFrontmatterBlock(afterOpening.slice(0, closingIndex));
  const body = parseBody(afterOpening.slice(closingIndex + FRONTMATTER_CLOSING.length));
  return validatePhaseDocument({
    id: frontmatter["id"],
    deps: frontmatter["deps"],
    agentRole: frontmatter["agent-role"],
    description: body.description,
    tasks: body.tasks,
    doneWhen: body.doneWhen,
  });
}

function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const separatorIndex = line.indexOf(KEY_VALUE_SEPARATOR);
    if (separatorIndex === -1) {
      throw new PhaseDocumentValidationError(`malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, separatorIndex);
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      throw new PhaseDocumentValidationError(`unknown frontmatter key: ${key}`);
    }
    if (key in parsed) {
      throw new PhaseDocumentValidationError(`duplicate frontmatter key: ${key}`);
    }
    parsed[key] = parseJsonValue(line.slice(separatorIndex + KEY_VALUE_SEPARATOR.length), key);
  }
  for (const requiredKey of REQUIRED_FRONTMATTER_KEYS) {
    if (!(requiredKey in parsed)) {
      throw new PhaseDocumentValidationError(`missing frontmatter key: ${requiredKey}`);
    }
  }
  return parsed;
}

function parseJsonValue(rawValue: string, key: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new PhaseDocumentValidationError(`frontmatter value for "${key}" is not valid JSON`);
  }
}

interface PhaseBody {
  description: string;
  tasks: string[];
  doneWhen: DoneWhenCriterion[];
}

type BodySection = "description" | "tasks" | "done-when";

function parseBody(body: string): PhaseBody {
  const lines = body.split("\n");
  const descriptionLines: string[] = [];
  const tasks: string[] = [];
  const doneWhen: DoneWhenCriterion[] = [];
  let section: BodySection = "description";
  let index = 0;
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.startsWith(SECTION_HEADER_PREFIX)) {
      section = enterSection(line, section);
      index += 1;
    } else if (section === "description") {
      descriptionLines.push(line);
      index += 1;
    } else if (line.trim() === "") {
      index += 1;
    } else if (section === "tasks") {
      tasks.push(parseTaskLine(line));
      index += 1;
    } else {
      index = parseCriterion(lines, index, doneWhen);
    }
  }
  requireBothSections(section);
  return { description: joinDescription(descriptionLines), tasks, doneWhen };
}

function enterSection(headerLine: string, currentSection: BodySection): BodySection {
  if (headerLine === TASKS_HEADER) {
    if (currentSection !== "description") {
      throw new PhaseDocumentValidationError(`duplicate or out-of-order section: ${TASKS_HEADER}`);
    }
    return "tasks";
  }
  if (headerLine === DONE_WHEN_HEADER) {
    if (currentSection === "description") {
      throw new PhaseDocumentValidationError(`${DONE_WHEN_HEADER} must come after ${TASKS_HEADER}`);
    }
    if (currentSection === "done-when") {
      throw new PhaseDocumentValidationError(`duplicate section: ${DONE_WHEN_HEADER}`);
    }
    return "done-when";
  }
  throw new PhaseDocumentValidationError(`unknown section header: ${headerLine}`);
}

function parseTaskLine(line: string): string {
  if (!line.startsWith(BULLET_PREFIX)) {
    throw new PhaseDocumentValidationError(`tasks section line must be a "- " bullet: ${line}`);
  }
  return line.slice(BULLET_PREFIX.length);
}

function parseCriterion(
  lines: string[],
  bulletIndex: number,
  doneWhen: DoneWhenCriterion[],
): number {
  const bulletLine = lineAt(lines, bulletIndex);
  if (bulletLine.startsWith(COMMAND_FENCE)) {
    throw new PhaseDocumentValidationError(
      "fenced command block without a preceding criterion bullet",
    );
  }
  if (!bulletLine.startsWith(BULLET_PREFIX)) {
    throw new PhaseDocumentValidationError(
      `done-when section line must be a "- " bullet: ${bulletLine}`,
    );
  }
  const description = bulletLine.slice(BULLET_PREFIX.length);
  if (lines[bulletIndex + 1] === AGENT_JUDGED_MARKER) {
    doneWhen.push({ kind: "agent-judged", description });
    return bulletIndex + 2;
  }
  const fencedCommand = readFencedCommand(lines, bulletIndex + 1);
  doneWhen.push({ kind: "executable", description, command: fencedCommand.command });
  return fencedCommand.nextIndex;
}

interface FencedCommand {
  command: string;
  nextIndex: number;
}

function readFencedCommand(lines: string[], openingIndex: number): FencedCommand {
  if (openingIndex >= lines.length || !isFenceOpening(lineAt(lines, openingIndex))) {
    throw new PhaseDocumentValidationError(
      `criterion bullet must be immediately followed by a fenced command block or the "${AGENT_JUDGED_MARKER}" marker`,
    );
  }
  let closingIndex = openingIndex + 1;
  while (closingIndex < lines.length && lineAt(lines, closingIndex) !== COMMAND_FENCE) {
    closingIndex += 1;
  }
  if (closingIndex >= lines.length) {
    throw new PhaseDocumentValidationError("unclosed fenced command block");
  }
  if (closingIndex !== openingIndex + 2) {
    throw new PhaseDocumentValidationError("fenced command block must contain exactly one line");
  }
  return { command: lineAt(lines, openingIndex + 1), nextIndex: closingIndex + 1 };
}

function isFenceOpening(line: string): boolean {
  if (!line.startsWith(COMMAND_FENCE)) {
    return false;
  }
  return !line.slice(COMMAND_FENCE.length).includes("`");
}

function requireBothSections(section: BodySection): void {
  if (section === "description") {
    throw new PhaseDocumentValidationError(`phase document is missing the ${TASKS_HEADER} section`);
  }
  if (section === "tasks") {
    throw new PhaseDocumentValidationError(
      `phase document is missing the ${DONE_WHEN_HEADER} section`,
    );
  }
}

function joinDescription(descriptionLines: string[]): string {
  let start = 0;
  let end = descriptionLines.length;
  while (start < end && lineAt(descriptionLines, start).trim() === "") {
    start += 1;
  }
  while (end > start && lineAt(descriptionLines, end - 1).trim() === "") {
    end -= 1;
  }
  return descriptionLines.slice(start, end).join("\n");
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`line index ${index} is out of bounds`);
  }
  return line;
}
