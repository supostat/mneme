export class PhaseDocumentValidationError extends Error {}

export interface ExecutableCriterion {
  kind: "executable";
  description: string;
  command: string;
}

export interface AgentJudgedCriterion {
  kind: "agent-judged";
  description: string;
}

export type DoneWhenCriterion = ExecutableCriterion | AgentJudgedCriterion;

export const AGENT_JUDGED_MARKER = "agent-judged: true";

export interface PhaseDocument {
  id: string;
  deps: string[];
  agentRole: string;
  description: string;
  tasks: string[];
  doneWhen: DoneWhenCriterion[];
}

export const PHASE_ID_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_PHASE_ID_LENGTH = 64;

export function isPhaseId(value: string): boolean {
  return value.length <= MAX_PHASE_ID_LENGTH && PHASE_ID_REGEX.test(value);
}

export const TASKS_HEADER = "## Tasks";
export const DONE_WHEN_HEADER = "## Done-when";
export const SECTION_HEADER_PREFIX = "## ";
export const BULLET_PREFIX = "- ";
export const COMMAND_FENCE = "```";

type CodePointRange = readonly [number, number];

const C0_CONTROLS: CodePointRange = [0x0000, 0x001f];
const C0_CONTROLS_BEFORE_LINE_FEED: CodePointRange = [0x0000, 0x0009];
const C0_CONTROLS_AFTER_LINE_FEED: CodePointRange = [0x000b, 0x001f];
const DELETE_AND_C1_CONTROLS: CodePointRange = [0x007f, 0x009f];
const SOFT_HYPHEN: CodePointRange = [0x00ad, 0x00ad];
const ARABIC_LETTER_MARK: CodePointRange = [0x061c, 0x061c];
const MONGOLIAN_VOWEL_SEPARATOR: CodePointRange = [0x180e, 0x180e];
const ZERO_WIDTH_CHARACTERS_AND_DIRECTIONAL_MARKS: CodePointRange = [0x200b, 0x200f];
const LINE_SEPARATORS_AND_BIDI_EMBEDDING_CONTROLS: CodePointRange = [0x2028, 0x202e];
const WORD_JOINER_AND_INVISIBLE_OPERATORS: CodePointRange = [0x2060, 0x2064];
const BIDI_ISOLATES: CodePointRange = [0x2066, 0x2069];
const ZERO_WIDTH_NO_BREAK_SPACE: CodePointRange = [0xfeff, 0xfeff];
const INTERLINEAR_ANNOTATION_CONTROLS: CodePointRange = [0xfff9, 0xfffb];
const TAG_CHARACTERS: CodePointRange = [0xe0000, 0xe007f];

const INVISIBLE_BEYOND_C0_RANGES: readonly CodePointRange[] = [
  DELETE_AND_C1_CONTROLS,
  SOFT_HYPHEN,
  ARABIC_LETTER_MARK,
  MONGOLIAN_VOWEL_SEPARATOR,
  ZERO_WIDTH_CHARACTERS_AND_DIRECTIONAL_MARKS,
  LINE_SEPARATORS_AND_BIDI_EMBEDDING_CONTROLS,
  WORD_JOINER_AND_INVISIBLE_OPERATORS,
  BIDI_ISOLATES,
  ZERO_WIDTH_NO_BREAK_SPACE,
  INTERLINEAR_ANNOTATION_CONTROLS,
  TAG_CHARACTERS,
];

function forbiddenCharacterRegex(ranges: readonly CodePointRange[]): RegExp {
  const characterClass = ranges
    .map(([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`)
    .join("");
  return new RegExp(`[${characterClass}]`, "u");
}

const SINGLE_LINE_FORBIDDEN_REGEX = forbiddenCharacterRegex([
  C0_CONTROLS,
  ...INVISIBLE_BEYOND_C0_RANGES,
]);
const DESCRIPTION_FORBIDDEN_REGEX = forbiddenCharacterRegex([
  C0_CONTROLS_BEFORE_LINE_FEED,
  C0_CONTROLS_AFTER_LINE_FEED,
  ...INVISIBLE_BEYOND_C0_RANGES,
]);

export function containsForbiddenCharacter(text: string): boolean {
  return DESCRIPTION_FORBIDDEN_REGEX.test(text);
}

export interface PhaseDocumentCandidate {
  id: unknown;
  deps: unknown;
  agentRole: unknown;
  description: string;
  tasks: string[];
  doneWhen: DoneWhenCriterion[];
}

export function validatePhaseDocument(candidate: PhaseDocumentCandidate): PhaseDocument {
  const id = validateId(candidate.id);
  return {
    id,
    deps: validateDeps(candidate.deps, id),
    agentRole: validateAgentRole(candidate.agentRole),
    description: validateDescription(candidate.description),
    tasks: validateTasks(candidate.tasks),
    doneWhen: validateDoneWhen(candidate.doneWhen),
  };
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !isPhaseId(value)) {
    throw new PhaseDocumentValidationError(
      `id must be a kebab-case slug of at most ${MAX_PHASE_ID_LENGTH} characters: ${String(value)}`,
    );
  }
  return value;
}

function validateDeps(value: unknown, id: string): string[] {
  if (!Array.isArray(value)) {
    throw new PhaseDocumentValidationError("deps must be an array of phase ids");
  }
  const deps = value.map(validateDependencyId);
  if (new Set(deps).size !== deps.length) {
    throw new PhaseDocumentValidationError(`deps must not contain duplicates: ${deps.join(", ")}`);
  }
  if (deps.includes(id)) {
    throw new PhaseDocumentValidationError(`phase "${id}" must not depend on itself`);
  }
  return deps;
}

function validateDependencyId(value: unknown): string {
  if (typeof value !== "string" || !isPhaseId(value)) {
    throw new PhaseDocumentValidationError(`dependency must be a valid phase id: ${String(value)}`);
  }
  return value;
}

function validateAgentRole(value: unknown): string {
  if (typeof value !== "string" || !isPhaseId(value)) {
    throw new PhaseDocumentValidationError(
      `agent-role must be a kebab-case slug of at most ${MAX_PHASE_ID_LENGTH} characters: ${String(value)}`,
    );
  }
  return value;
}

function validateDescription(description: string): string {
  if (description === "") {
    return description;
  }
  if (DESCRIPTION_FORBIDDEN_REGEX.test(description)) {
    throw new PhaseDocumentValidationError(
      "description must not contain control or invisible characters other than newline",
    );
  }
  const descriptionLines = description.split("\n");
  const firstLine = descriptionLines[0];
  const lastLine = descriptionLines[descriptionLines.length - 1];
  if (firstLine === undefined || lastLine === undefined) {
    throw new Error("a non-empty description must split into at least one line");
  }
  if (firstLine.trim() === "" || lastLine.trim() === "") {
    throw new PhaseDocumentValidationError("description must not start or end with a blank line");
  }
  for (const line of descriptionLines) {
    if (line.startsWith(SECTION_HEADER_PREFIX)) {
      throw new PhaseDocumentValidationError(
        `description must not contain a section header line: ${line}`,
      );
    }
  }
  return description;
}

function validateTasks(tasks: string[]): string[] {
  if (tasks.length === 0) {
    throw new PhaseDocumentValidationError(`${TASKS_HEADER} must contain at least one task bullet`);
  }
  return tasks.map((task) => validateSingleLine(task, "task"));
}

function validateDoneWhen(doneWhen: DoneWhenCriterion[]): DoneWhenCriterion[] {
  if (doneWhen.length === 0) {
    throw new PhaseDocumentValidationError(
      `${DONE_WHEN_HEADER} must contain at least one criterion`,
    );
  }
  return doneWhen.map(validateCriterion);
}

function validateCriterion(criterion: DoneWhenCriterion): DoneWhenCriterion {
  if (criterion.kind === "agent-judged") {
    return {
      kind: "agent-judged",
      description: validateSingleLine(criterion.description, "criterion description"),
    };
  }
  if (criterion.kind === "executable") {
    const description = validateSingleLine(criterion.description, "criterion description");
    const command = validateSingleLine(criterion.command, "done-when command");
    if (command.startsWith(COMMAND_FENCE)) {
      throw new PhaseDocumentValidationError(
        `done-when command must not start with a fence: ${command}`,
      );
    }
    return { kind: "executable", description, command };
  }
  throw new PhaseDocumentValidationError(
    `done-when criterion has an unknown kind: ${String((criterion as { kind?: unknown }).kind)}`,
  );
}

function validateSingleLine(value: string, label: string): string {
  if (value.trim() === "") {
    throw new PhaseDocumentValidationError(`${label} must be non-empty`);
  }
  if (SINGLE_LINE_FORBIDDEN_REGEX.test(value)) {
    throw new PhaseDocumentValidationError(
      `${label} must be a single line without control or invisible characters`,
    );
  }
  return value;
}
