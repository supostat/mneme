import {
  DEFAULT_AGENT_ROLE,
  DEFAULT_DONE_WHEN,
  PhaseGenerationError,
  buildPhaseDescription,
  parsePhaseHeading,
  validateGeneratedGraph,
} from "./phase-generation";
import type { PhaseHeading } from "./phase-generation";
import type { ExecutableCriterion, PhaseDocument } from "./phase-document";

const GAMEPLAN_HEADING = "# Gameplan";
const LEVEL_ONE_HEADING_PREFIX = "# ";
const DONE_WHEN_PREFIX = "**Done when:**";
const TASK_BULLET_REGEX = /^- \[[ xX]\]\s+(.+)$/;

interface SpecPhase {
  heading: PhaseHeading;
  tasks: string[];
  acceptanceProse: string;
}

export function phaseDocumentsFromSpec(
  specText: string,
  doneWhen: readonly ExecutableCriterion[] = DEFAULT_DONE_WHEN,
): PhaseDocument[] {
  if (doneWhen.length === 0) {
    throw new PhaseGenerationError("from-spec requires at least one executable done-when criterion");
  }
  const specPhases = parseSpecPhases(extractGameplanSection(specText));
  if (specPhases.length === 0) {
    throw new PhaseGenerationError("the # Gameplan section contains no phase headings");
  }
  const documents: PhaseDocument[] = [];
  let previousId: string | null = null;
  for (const specPhase of specPhases) {
    const document = documentFromSpecPhase(specPhase, previousId, doneWhen);
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
    const line = lines[index];
    if (line === undefined) {
      throw new PhaseGenerationError("spec line vanished during gameplan extraction");
    }
    if (line.startsWith(LEVEL_ONE_HEADING_PREFIX)) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

function parseSpecPhases(gameplanText: string): SpecPhase[] {
  const specPhases: SpecPhase[] = [];
  for (const line of gameplanText.split("\n")) {
    const heading = parsePhaseHeading(line);
    if (heading !== null) {
      specPhases.push({ heading, tasks: [], acceptanceProse: "" });
      continue;
    }
    const current = specPhases[specPhases.length - 1];
    if (current !== undefined) {
      appendPhaseDetail(current, line);
    }
  }
  return specPhases;
}

function appendPhaseDetail(specPhase: SpecPhase, line: string): void {
  const taskMatch = TASK_BULLET_REGEX.exec(line);
  if (taskMatch !== null) {
    const taskText = taskMatch[1];
    if (taskText === undefined) {
      throw new PhaseGenerationError(`task bullet matched without its capture group: ${line}`);
    }
    specPhase.tasks.push(taskText);
    return;
  }
  if (line.startsWith(DONE_WHEN_PREFIX)) {
    specPhase.acceptanceProse = line.slice(DONE_WHEN_PREFIX.length).trim();
  }
}

function documentFromSpecPhase(
  specPhase: SpecPhase,
  previousId: string | null,
  doneWhen: readonly ExecutableCriterion[],
): PhaseDocument {
  if (specPhase.tasks.length === 0) {
    throw new PhaseGenerationError(`phase "${specPhase.heading.id}" has no task bullets`);
  }
  return {
    id: specPhase.heading.id,
    deps: previousId === null ? [] : [previousId],
    agentRole: DEFAULT_AGENT_ROLE,
    description: buildPhaseDescription(specPhase.heading.title, specPhase.acceptanceProse),
    tasks: specPhase.tasks,
    doneWhen: [...doneWhen],
  };
}
