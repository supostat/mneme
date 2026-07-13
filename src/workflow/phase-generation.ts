import { buildPhaseGraph } from "./phase-graph";
import type { PhaseGraph } from "./phase-graph";
import { isPhaseId, serializePhaseDocument } from "./phase-document";
import type { ExecutableCriterion, PhaseDocument } from "./phase-document";

export class PhaseGenerationError extends Error {}

export const DEFAULT_AGENT_ROLE = "coder";

export const DEFAULT_DONE_WHEN: readonly ExecutableCriterion[] = [
  { kind: "executable", description: "the phase verification suite passes", command: "bun test" },
];

const TITLE_SEPARATOR = ` ${String.fromCharCode(0x2014)} `;
const PHASE_HEADING_REGEX = /^#{1,3} Phase (\d+): (.+)$/;

export interface PhaseHeading {
  number: number;
  id: string;
  title: string;
}

export function parsePhaseHeading(line: string): PhaseHeading | null {
  const match = PHASE_HEADING_REGEX.exec(line);
  if (match === null) {
    return null;
  }
  const phaseNumber = match[1];
  const remainder = match[2];
  if (phaseNumber === undefined || remainder === undefined) {
    throw new PhaseGenerationError(`phase heading matched without its capture groups: ${line}`);
  }
  const separatorIndex = remainder.indexOf(TITLE_SEPARATOR);
  const label = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  const title =
    separatorIndex === -1 ? "" : remainder.slice(separatorIndex + TITLE_SEPARATOR.length);
  return { number: Number.parseInt(phaseNumber, 10), id: slugify(label), title };
}

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!isPhaseId(slug)) {
    throw new PhaseGenerationError(`cannot derive a valid phase id from label: ${label}`);
  }
  return slug;
}

export function buildPhaseDescription(title: string, acceptanceProse: string): string {
  return [title, acceptanceProse]
    .map((part) => trimSurroundingBlankLines(part.split("\n")).join("\n"))
    .filter((part) => part !== "")
    .join("\n\n");
}

function trimSurroundingBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start])) {
    start += 1;
  }
  while (end > start && isBlankLine(lines[end - 1])) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function isBlankLine(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

export function validateGeneratedGraph(documents: PhaseDocument[]): PhaseGraph {
  for (const document of documents) {
    serializePhaseDocument(document);
  }
  return buildPhaseGraph(documents);
}
