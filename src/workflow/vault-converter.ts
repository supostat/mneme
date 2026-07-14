import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AGENT_ROLE,
  DEFAULT_DONE_WHEN,
  buildPhaseDescription,
  parsePhaseHeading,
  validateGeneratedGraph,
} from "./phase-generation";
import { VaultConversionError, parsePhaseFile } from "./vault-phase-file";
import type { ParsedPhaseFile } from "./vault-phase-file";
import { containsForbiddenCharacter } from "./phase-document";
import type { PhaseDocument } from "./phase-document";

export { VaultConversionError } from "./vault-phase-file";

export type KnowledgeDestination = "claude-md" | "mneme-notes" | "docs";
export type KnowledgeRouting = Readonly<Record<string, KnowledgeDestination>>;

export interface RoutedKnowledgeSection {
  heading: string;
  destination: KnowledgeDestination;
  content: string;
}

export interface VaultConversion {
  phases: PhaseDocument[];
  knowledge: RoutedKnowledgeSection[];
}

interface KnowledgeSection {
  heading: string;
  content: string;
}

const SECTION_HEADER_PREFIX = "## ";
const PHASE_FILE_REGEX = /^phase-\d+-.*\.md$/;
const PLAN_FILE_SUFFIX = ".plan.md";
const PHASES_SECTION_HEADER = "## Phases";

export function convertVault(vaultPath: string, knowledgeRouting: KnowledgeRouting): VaultConversion {
  const phaseFiles = readPhaseFiles(vaultPath);
  const phaseNumberToId = mapPhaseNumbersToIds(phaseFiles);
  assertRosterMatches(readGameplanRoster(vaultPath), phaseFiles);
  const phases = buildPhasesFromFiles(phaseFiles, phaseNumberToId);
  validateGeneratedGraph(phases);
  return { phases, knowledge: routeKnowledge(readKnowledgeSections(vaultPath), knowledgeRouting) };
}

function readVaultFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new VaultConversionError(`cannot read vault file at ${filePath}`, { cause });
  }
}

function readPhaseFiles(vaultPath: string): ParsedPhaseFile[] {
  const phasesDirectory = join(vaultPath, "phases");
  let entries: string[];
  try {
    entries = readdirSync(phasesDirectory);
  } catch (cause) {
    throw new VaultConversionError(`cannot read phases directory at ${phasesDirectory}`, { cause });
  }
  const phaseFiles = entries
    .filter((entry) => PHASE_FILE_REGEX.test(entry) && !entry.endsWith(PLAN_FILE_SUFFIX))
    .sort()
    .map((entry) => parsePhaseFile(readVaultFile(join(phasesDirectory, entry))));
  if (phaseFiles.length === 0) {
    throw new VaultConversionError(`no phase files found in ${phasesDirectory}`);
  }
  return phaseFiles;
}

function mapPhaseNumbersToIds(phaseFiles: ParsedPhaseFile[]): Map<number, string> {
  const phaseNumberToId = new Map<number, string>();
  for (const phaseFile of phaseFiles) {
    if (phaseNumberToId.has(phaseFile.number)) {
      throw new VaultConversionError(`duplicate phase number ${phaseFile.number} across phase files`);
    }
    phaseNumberToId.set(phaseFile.number, phaseFile.heading.id);
  }
  return phaseNumberToId;
}

function readGameplanRoster(vaultPath: string): Set<string> {
  const lines = readVaultFile(join(vaultPath, "gameplan.md")).split("\n");
  const startIndex = lines.indexOf(PHASES_SECTION_HEADER);
  if (startIndex === -1) {
    throw new VaultConversionError("gameplan.md is missing a ## Phases section");
  }
  const roster = new Set<string>();
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      throw new VaultConversionError("gameplan line vanished during roster extraction");
    }
    if (line.startsWith(SECTION_HEADER_PREFIX)) {
      break;
    }
    const heading = parsePhaseHeading(line);
    if (heading !== null) {
      roster.add(heading.id);
    }
  }
  return roster;
}

function assertRosterMatches(roster: Set<string>, phaseFiles: ParsedPhaseFile[]): void {
  const fileIds = new Set(phaseFiles.map((phaseFile) => phaseFile.heading.id));
  for (const rosterId of roster) {
    if (!fileIds.has(rosterId)) {
      throw new VaultConversionError(`gameplan lists phase "${rosterId}" but no phase file provides it`);
    }
  }
  for (const fileId of fileIds) {
    if (!roster.has(fileId)) {
      throw new VaultConversionError(`phase file provides "${fileId}" but the gameplan omits it`);
    }
  }
}

function buildPhasesFromFiles(
  phaseFiles: ParsedPhaseFile[],
  phaseNumberToId: Map<number, string>,
): PhaseDocument[] {
  return phaseFiles.map((phaseFile) => ({
    id: phaseFile.heading.id,
    deps: dependencyIds(phaseFile, phaseNumberToId),
    agentRole: DEFAULT_AGENT_ROLE,
    description: buildPhaseDescription(phaseFile.heading.title, phaseFile.acceptanceProse),
    tasks: phaseFile.tasks,
    doneWhen: [...DEFAULT_DONE_WHEN],
    knowledge: [],
  }));
}

function dependencyIds(phaseFile: ParsedPhaseFile, phaseNumberToId: Map<number, string>): string[] {
  if (phaseFile.dependsOn === null) {
    return [];
  }
  const dependencyId = phaseNumberToId.get(phaseFile.dependsOn);
  if (dependencyId === undefined) {
    throw new VaultConversionError(
      `phase ${phaseFile.number} depends on phase ${phaseFile.dependsOn} which has no phase file`,
    );
  }
  return [dependencyId];
}

function readKnowledgeSections(vaultPath: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let current: { heading: string; contentLines: string[] } | null = null;
  for (const line of readVaultFile(join(vaultPath, "knowledge.md")).split("\n")) {
    if (line.startsWith(SECTION_HEADER_PREFIX)) {
      if (current !== null) {
        sections.push({ heading: current.heading, content: current.contentLines.join("\n") });
      }
      current = { heading: line.slice(SECTION_HEADER_PREFIX.length), contentLines: [] };
    } else if (current !== null) {
      current.contentLines.push(line);
    }
  }
  if (current !== null) {
    sections.push({ heading: current.heading, content: current.contentLines.join("\n") });
  }
  return sections;
}

function assertKnowledgeFreeOfForbiddenCharacters(sections: KnowledgeSection[]): void {
  for (const section of sections) {
    if (containsForbiddenCharacter(section.heading) || containsForbiddenCharacter(section.content)) {
      throw new VaultConversionError(
        `knowledge section "${section.heading}" contains a forbidden control or invisible character`,
      );
    }
  }
}

function routeKnowledge(
  sections: KnowledgeSection[],
  routing: KnowledgeRouting,
): RoutedKnowledgeSection[] {
  assertKnowledgeFreeOfForbiddenCharacters(sections);
  const unrouted = sections
    .filter((section) => routedDestination(section.heading, routing) === undefined)
    .map((section) => section.heading);
  if (unrouted.length > 0) {
    throw new VaultConversionError(`knowledge sections lack a routing entry: ${unrouted.join(", ")}`);
  }
  const sectionHeadings = new Set(sections.map((section) => section.heading));
  const staleKeys = Object.keys(routing).filter((key) => !sectionHeadings.has(key));
  if (staleKeys.length > 0) {
    throw new VaultConversionError(`routing names knowledge sections that are absent: ${staleKeys.join(", ")}`);
  }
  return sections.map((section) => ({
    heading: section.heading,
    destination: requireDestination(section.heading, routing),
    content: section.content,
  }));
}

function routedDestination(heading: string, routing: KnowledgeRouting): KnowledgeDestination | undefined {
  if (!Object.prototype.hasOwnProperty.call(routing, heading)) {
    return undefined;
  }
  return routing[heading];
}

function requireDestination(heading: string, routing: KnowledgeRouting): KnowledgeDestination {
  const destination = routedDestination(heading, routing);
  if (destination === undefined) {
    throw new VaultConversionError(`knowledge section "${heading}" has no routing entry`);
  }
  return destination;
}
