import { tokenizeCommand } from "./gate-runner";
import {
  DEFAULT_AGENT_ROLE,
  PhaseGenerationError,
  buildPhaseDescription,
  parsePhaseHeading,
  validateGeneratedGraph,
} from "./phase-generation";
import type { PhaseHeading } from "./phase-generation";
import { BULLET_PREFIX, COMMAND_FENCE, isFenceOpening } from "./phase-document";
import type { ExecutableCriterion, PhaseDocument } from "./phase-document";

const GAMEPLAN_HEADING = "# Gameplan";
const KNOWLEDGE_HEADING = "# Knowledge";
const LEVEL_ONE_HEADING_PREFIX = "# ";
const DONE_WHEN_PREFIX = "**Done when:**";
const EXECUTABLE_DONE_WHEN_MARKER = "**Done when (EXECUTABLE):**";
const TASK_BULLET_REGEX = /^- \[[ xX]\]\s+(.+)$/;

interface SpecPhase {
  heading: PhaseHeading;
  tasks: string[];
  acceptanceProse: string;
  criteria: ExecutableCriterion[];
}

export function phaseDocumentsFromSpec(specText: string): PhaseDocument[] {
  const specPhases = parseSpecPhases(extractGameplanSection(specText));
  if (specPhases.length === 0) {
    throw new PhaseGenerationError("the # Gameplan section contains no phase headings");
  }
  const knowledge = extractKnowledgeSection(specText);
  const documents: PhaseDocument[] = [];
  let previousId: string | null = null;
  for (const specPhase of specPhases) {
    const document = documentFromSpecPhase(specPhase, previousId, knowledge);
    documents.push(document);
    previousId = document.id;
  }
  validateGeneratedGraph(documents);
  return documents;
}

function extractGameplanSection(specText: string): string {
  const lines = specText.split("\n");
  const startIndex = lines.indexOf(GAMEPLAN_HEADING);
  if (startIndex === -1) {
    throw new PhaseGenerationError("the spec is missing a # Gameplan section");
  }
  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lineAt(lines, index);
    if (line.startsWith(LEVEL_ONE_HEADING_PREFIX)) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

function extractKnowledgeSection(specText: string): string[] {
  const lines = specText.split("\n");
  const startIndex = lines.indexOf(KNOWLEDGE_HEADING);
  if (startIndex === -1) {
    return [];
  }
  const bullets: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lineAt(lines, index);
    if (line.startsWith(LEVEL_ONE_HEADING_PREFIX)) {
      break;
    }
    if (line.startsWith(BULLET_PREFIX)) {
      bullets.push(line.slice(BULLET_PREFIX.length));
    }
  }
  return bullets;
}

function parseSpecPhases(gameplanText: string): SpecPhase[] {
  const lines = gameplanText.split("\n");
  const specPhases: SpecPhase[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lineAt(lines, index);
    const heading = parsePhaseHeading(line);
    if (heading !== null) {
      specPhases.push({ heading, tasks: [], acceptanceProse: "", criteria: [] });
      index += 1;
      continue;
    }
    const current = specPhases[specPhases.length - 1];
    if (current === undefined) {
      index += 1;
      continue;
    }
    index = consumePhaseDetail(current, lines, index);
  }
  return specPhases;
}

function consumePhaseDetail(specPhase: SpecPhase, lines: string[], index: number): number {
  const line = lineAt(lines, index);
  const taskMatch = TASK_BULLET_REGEX.exec(line);
  if (taskMatch !== null) {
    const taskText = taskMatch[1];
    if (taskText === undefined) {
      throw new PhaseGenerationError(`task bullet matched without its capture group: ${line}`);
    }
    specPhase.tasks.push(taskText);
    return index + 1;
  }
  if (line === EXECUTABLE_DONE_WHEN_MARKER) {
    return parseCriteriaBlock(lines, index + 1, specPhase.criteria);
  }
  if (isFenceOpening(line)) {
    throw new PhaseGenerationError(
      "a fenced done-when command must sit directly inside an executable done-when block, with no blank line separating adjacent criteria",
    );
  }
  if (line.startsWith(DONE_WHEN_PREFIX)) {
    specPhase.acceptanceProse = line.slice(DONE_WHEN_PREFIX.length).trim();
  }
  return index + 1;
}

function parseCriteriaBlock(
  lines: string[],
  startIndex: number,
  criteria: ExecutableCriterion[],
): number {
  const countBeforeBlock = criteria.length;
  let index = startIndex;
  while (index < lines.length && isFenceOpening(lineAt(lines, index))) {
    index = parseFenceFirstCriterion(lines, index, criteria);
  }
  if (criteria.length === countBeforeBlock) {
    throw new PhaseGenerationError(
      "an executable done-when block must contain at least one fenced criterion",
    );
  }
  return index;
}

function parseFenceFirstCriterion(
  lines: string[],
  fenceIndex: number,
  criteria: ExecutableCriterion[],
): number {
  const fencedCommand = readFencedSpecCommand(lines, fenceIndex);
  const trailingProse = readTrailingProse(lines, fencedCommand.nextIndex);
  criteria.push({
    kind: "executable",
    description: trailingProse.description,
    command: fencedCommand.command,
  });
  return trailingProse.nextIndex;
}

interface FencedSpecCommand {
  command: string;
  nextIndex: number;
}

function readFencedSpecCommand(lines: string[], openingIndex: number): FencedSpecCommand {
  let closingIndex = openingIndex + 1;
  while (closingIndex < lines.length && lineAt(lines, closingIndex) !== COMMAND_FENCE) {
    closingIndex += 1;
  }
  if (closingIndex >= lines.length) {
    throw new PhaseGenerationError("unclosed fenced command block in an executable done-when");
  }
  if (closingIndex !== openingIndex + 2) {
    throw new PhaseGenerationError(
      "a fenced executable done-when command must contain exactly one line",
    );
  }
  return { command: lineAt(lines, openingIndex + 1), nextIndex: closingIndex + 1 };
}

interface TrailingProse {
  description: string;
  nextIndex: number;
}

function readTrailingProse(lines: string[], startIndex: number): TrailingProse {
  const proseLines: string[] = [];
  let index = startIndex;
  while (index < lines.length && isProseContinuation(lineAt(lines, index))) {
    proseLines.push(lineAt(lines, index).trim());
    index += 1;
  }
  if (proseLines.length === 0) {
    throw new PhaseGenerationError(
      "a fenced executable done-when criterion must be followed by a prose description",
    );
  }
  return { description: proseLines.join(" "), nextIndex: index };
}

function isProseContinuation(line: string): boolean {
  return line.trim() !== "" && parsePhaseHeading(line) === null && !isFenceOpening(line);
}

function documentFromSpecPhase(
  specPhase: SpecPhase,
  previousId: string | null,
  knowledge: string[],
): PhaseDocument {
  if (specPhase.tasks.length === 0) {
    throw new PhaseGenerationError(`phase "${specPhase.heading.id}" has no task bullets`);
  }
  requireExecutableCriterion(specPhase);
  for (const criterion of specPhase.criteria) {
    requireSpawnableCommand(specPhase.heading.id, criterion);
  }
  return {
    id: specPhase.heading.id,
    deps: previousId === null ? [] : [previousId],
    agentRole: DEFAULT_AGENT_ROLE,
    description: buildPhaseDescription(specPhase.heading.title, specPhase.acceptanceProse),
    tasks: specPhase.tasks,
    doneWhen: [...specPhase.criteria],
    knowledge: [...knowledge],
  };
}

function requireExecutableCriterion(specPhase: SpecPhase): void {
  if (specPhase.criteria.length === 0) {
    throw new PhaseGenerationError(
      `phase "${specPhase.heading.id}" has no executable done-when criterion`,
    );
  }
}

// The gate-runner spawns a done-when command as ONE argv process, never a shell: quotes throw at
// tokenize time, and shell operators survive tokenization as literal arguments only to burn a run
// attempt at gate time — the command is frozen into the run's event log, so a retry is doomed by
// construction. Generation is the last moment the author can still fix the spec, which is why a
// command carrying a shell construction fails HERE, named, with the cure.
const SHELL_CONSTRUCTIONS: ReadonlyArray<{ marker: string; name: string }> = [
  { marker: "$(", name: "command substitution $()" },
  { marker: '"', name: "double quotes" },
  { marker: "'", name: "single quotes" },
  { marker: "&&", name: "the && chain" },
  { marker: "||", name: "the || chain" },
  { marker: "|", name: "the | pipe" },
  { marker: ";", name: "the ; separator" },
];

function requireSpawnableCommand(phaseId: string, criterion: ExecutableCriterion): void {
  const construction = SHELL_CONSTRUCTIONS.find((candidate) =>
    criterion.command.includes(candidate.marker),
  );
  if (construction !== undefined) {
    throw new PhaseGenerationError(
      `phase "${phaseId}" done-when command uses ${construction.name}: ${criterion.command}. ` +
        "The gate-runner spawns one argv command without a shell, so the construction can never run. " +
        'If the criterion needs a shell, wrap it in a package.json script and call it as "bun run <name>".',
    );
  }
  try {
    tokenizeCommand(criterion.command);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    throw new PhaseGenerationError(`phase "${phaseId}" done-when command is not spawnable: ${problem}`);
  }
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new PhaseGenerationError(`spec line index ${index} is out of bounds`);
  }
  return line;
}
