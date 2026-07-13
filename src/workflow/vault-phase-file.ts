import { parsePhaseHeading } from "./phase-generation";
import type { PhaseHeading } from "./phase-generation";

export class VaultConversionError extends Error {}

export interface ParsedPhaseFile {
  number: number;
  dependsOn: number | null;
  heading: PhaseHeading;
  acceptanceProse: string;
  tasks: string[];
}

const SECTION_HEADER_PREFIX = "## ";
const TASK_LINE_REGEX = /^\d+\.\s+(.+)$/;
const KEY_VALUE_SEPARATOR = ": ";
const FRONTMATTER_FENCE = "---\n";
const FRONTMATTER_CLOSING = "\n---\n";

export function parsePhaseFile(fileText: string): ParsedPhaseFile {
  const { frontmatterBlock, body } = splitFrontmatterAndBody(fileText);
  const frontmatter = parseFrontmatterBlock(frontmatterBlock);
  const phaseNumber = requiredPhaseNumber(frontmatter);
  const bodyLines = body.split("\n");
  return {
    number: phaseNumber,
    dependsOn: requiredDependsOn(frontmatter),
    heading: phaseHeadingFromBody(bodyLines, phaseNumber),
    acceptanceProse: (extractSectionContent(bodyLines, "## Goal") ?? []).join("\n"),
    tasks: tasksFromSection(bodyLines),
  };
}

function splitFrontmatterAndBody(fileText: string): { frontmatterBlock: string; body: string } {
  if (!fileText.startsWith(FRONTMATTER_FENCE)) {
    throw new VaultConversionError("phase file is missing an opening frontmatter fence");
  }
  const afterOpening = fileText.slice(FRONTMATTER_FENCE.length);
  const closingIndex = afterOpening.indexOf(FRONTMATTER_CLOSING);
  if (closingIndex === -1) {
    throw new VaultConversionError("phase file is missing a closing frontmatter fence");
  }
  return {
    frontmatterBlock: afterOpening.slice(0, closingIndex),
    body: afterOpening.slice(closingIndex + FRONTMATTER_CLOSING.length),
  };
}

function parseFrontmatterBlock(block: string): Map<string, string> {
  const frontmatter = new Map<string, string>();
  for (const line of block.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const separatorIndex = line.indexOf(KEY_VALUE_SEPARATOR);
    if (separatorIndex === -1) {
      throw new VaultConversionError(`malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, separatorIndex);
    frontmatter.set(key, line.slice(separatorIndex + KEY_VALUE_SEPARATOR.length));
  }
  return frontmatter;
}

function requiredPhaseNumber(frontmatter: Map<string, string>): number {
  const raw = frontmatter.get("phase");
  if (raw === undefined) {
    throw new VaultConversionError("phase file frontmatter is missing the phase key");
  }
  return integerFieldValue(raw, "phase");
}

function requiredDependsOn(frontmatter: Map<string, string>): number | null {
  const raw = frontmatter.get("depends_on");
  if (raw === undefined) {
    throw new VaultConversionError("phase file frontmatter is missing the depends_on key");
  }
  return raw === "null" ? null : integerFieldValue(raw, "depends_on");
}

function integerFieldValue(raw: string, key: string): number {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(parsed)) {
    throw new VaultConversionError(`phase file frontmatter has a non-integer ${key}: ${raw}`);
  }
  return parsed;
}

function phaseHeadingFromBody(bodyLines: string[], phaseNumber: number): PhaseHeading {
  for (const line of bodyLines) {
    const heading = parsePhaseHeading(line);
    if (heading === null) {
      continue;
    }
    if (heading.number !== phaseNumber) {
      throw new VaultConversionError(
        `phase file H1 number ${heading.number} does not match frontmatter phase ${phaseNumber}`,
      );
    }
    return heading;
  }
  throw new VaultConversionError(`phase file is missing a "# Phase ${phaseNumber}:" heading`);
}

function tasksFromSection(bodyLines: string[]): string[] {
  const sectionLines = extractSectionContent(bodyLines, "## Tasks");
  if (sectionLines === null) {
    throw new VaultConversionError("phase file is missing a ## Tasks section");
  }
  const tasks: string[] = [];
  for (const line of sectionLines) {
    const match = TASK_LINE_REGEX.exec(line);
    if (match === null) {
      continue;
    }
    const taskText = match[1];
    if (taskText === undefined) {
      throw new VaultConversionError(`task line matched without its capture group: ${line}`);
    }
    tasks.push(taskText);
  }
  if (tasks.length === 0) {
    throw new VaultConversionError("phase file ## Tasks section has no numbered tasks");
  }
  return tasks;
}

function extractSectionContent(bodyLines: string[], headerLine: string): string[] | null {
  const startIndex = bodyLines.indexOf(headerLine);
  if (startIndex === -1) {
    return null;
  }
  const contentLines: string[] = [];
  for (let index = startIndex + 1; index < bodyLines.length; index += 1) {
    const line = bodyLines[index];
    if (line === undefined) {
      throw new VaultConversionError("body line vanished during section extraction");
    }
    if (line.startsWith(SECTION_HEADER_PREFIX)) {
      break;
    }
    contentLines.push(line);
  }
  return contentLines;
}
