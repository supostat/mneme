import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MapLayout } from "../corpus";
import {
  MAP_SECTION_KINDS,
  MapSectionValidationError,
  parseMapSection,
  serializeMapSection,
} from "./map-section";
import type { MapSection, MapSectionKind } from "./map-section";

// map/ is the corpus truth for sections exactly as notes/ is for notes. INDEX.md and glossary.md
// are DERIVED from the section files and rewritten whole on every change — never edited by hand or
// by the plugin. Reads are fail-closed: a file that does not parse, or whose name or directory
// disagrees with its frontmatter, is a named error, never a silently skipped section.

const SECTION_EXTENSION = ".md";
export const MAP_INDEX_HEADING = "# Project map";
const GLOSSARY_HEADER = ["| term | domain |", "| --- | --- |"];
const MARKDOWN_TABLE_PIPE = "|";
const ESCAPED_TABLE_PIPE = "\\|";

export interface DanglingDependency {
  id: string;
  kind: MapSectionKind;
  missing: string[];
}

export function sectionDirectory(layout: MapLayout, kind: MapSectionKind): string {
  return kind === "domain" ? layout.mapDomainsDir : layout.mapFlowsDir;
}

export function sectionPath(layout: MapLayout, kind: MapSectionKind, id: string): string {
  return join(sectionDirectory(layout, kind), `${id}${SECTION_EXTENSION}`);
}

// A section file as the directory names it, before it is read: the id is the file name.
export interface MapSectionFile {
  path: string;
  kind: MapSectionKind;
  id: string;
}

// Domains first, then flows, each sorted by id — the order every consumer (the index, the
// derived files, the listing) sees, so no two of them disagree. A corpus provisioned before the
// map existed has no map/ yet: that is an EMPTY map, not a fault — resolveCorpus creates the
// directories on the next tool call.
export function readMapSections(layout: MapLayout): MapSection[] {
  return readSectionFiles(listSectionFiles(layout));
}

// Listed without being parsed, so a caller can tell which files an id holds even when one of them
// would not read — the delete of a broken or duplicated section relies on it.
export function listSectionFiles(layout: MapLayout): MapSectionFile[] {
  const files: MapSectionFile[] = [];
  for (const kind of MAP_SECTION_KINDS) {
    const directory = sectionDirectory(layout, kind);
    if (!existsSync(directory)) continue;
    const names = readdirSync(directory)
      .filter((name) => name.endsWith(SECTION_EXTENSION))
      .sort();
    for (const name of names) {
      files.push({ path: join(directory, name), kind, id: basename(name, SECTION_EXTENSION) });
    }
  }
  return files;
}

// One id lives in one directory: the index keys sections by id, so an id held by both kinds is
// refused here by name — with both paths — instead of surfacing as a bare PRIMARY KEY failure in
// the rebuild and passing the doctor as healthy.
export function readSectionFiles(files: MapSectionFile[]): MapSection[] {
  requireOneFilePerId(files);
  return files.map((file) => readSectionFile(file.path, file.kind));
}

function requireOneFilePerId(files: MapSectionFile[]): void {
  const pathById = new Map<string, string>();
  for (const file of files) {
    const heldBy = pathById.get(file.id);
    if (heldBy !== undefined) {
      throw new MapSectionValidationError(
        `map section id "${file.id}" is held by both ${heldBy} and ${file.path}; ` +
          "delete it with map_delete and put it back as one kind",
      );
    }
    pathById.set(file.id, file.path);
  }
}

// Every fault names the file: the doctor and the rebuild report it verbatim, and a curator with
// a path can open the offending section without searching the corpus.
function readSectionFile(path: string, kind: MapSectionKind): MapSection {
  let section: MapSection;
  try {
    section = parseMapSection(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MapSectionValidationError(`map section file ${path} is unreadable: ${errorMessage(error)}`);
  }
  const expectedId = basename(path, SECTION_EXTENSION);
  if (section.frontmatter.kind !== kind) {
    throw new MapSectionValidationError(
      `map section file ${path} declares kind "${section.frontmatter.kind}" but lives in the ${kind} directory`,
    );
  }
  if (section.frontmatter.id !== expectedId) {
    throw new MapSectionValidationError(
      `map section file ${path} declares id "${section.frontmatter.id}", expected "${expectedId}"`,
    );
  }
  return section;
}

export function writeMapSection(layout: MapLayout, section: MapSection): void {
  writeFileSync(
    sectionPath(layout, section.frontmatter.kind, section.frontmatter.id),
    serializeMapSection(section),
  );
}

// A missing file throws: the caller decides whether a section exists before asking for its removal.
export function removeMapSection(layout: MapLayout, kind: MapSectionKind, id: string): void {
  rmSync(sectionPath(layout, kind, id));
}

export function renderMapIndex(sections: MapSection[]): string {
  const domains = sections.filter(isDomain).sort(byId);
  if (domains.length === 0) return `${MAP_INDEX_HEADING}\n`;
  const lines = domains.map((section) => `- ${section.frontmatter.id} — ${firstLineOf(section.body)}`);
  return `${MAP_INDEX_HEADING}\n\n${lines.join("\n")}\n`;
}

// One row per (term, domain): a term shared by two domains appears twice, sorted by term then id.
// A flow's terms feed FTS only and never reach the glossary.
export function renderGlossary(sections: MapSection[]): string {
  const rows: Array<{ term: string; domain: string }> = [];
  for (const section of sections.filter(isDomain)) {
    for (const term of section.frontmatter.terms) {
      rows.push({ term, domain: section.frontmatter.id });
    }
  }
  rows.sort((left, right) => compare(left.term, right.term) || compare(left.domain, right.domain));
  const lines = [...GLOSSARY_HEADER, ...rows.map((row) => `| ${escapeTablePipes(row.term)} | ${row.domain} |`)];
  return `${lines.join("\n")}\n`;
}

export function writeDerivedFiles(layout: MapLayout, sections: MapSection[]): void {
  writeFileSync(layout.mapIndexPath, renderMapIndex(sections));
  writeFileSync(layout.glossaryPath, renderGlossary(sections));
}

// A dependency on a section that does not exist is reported, never refused: sections are written
// one at a time and a flow may legitimately precede the domain it crosses.
export function findDanglingDependencies(sections: MapSection[]): DanglingDependency[] {
  const known = new Set(sections.map((section) => section.frontmatter.id));
  const dangling: DanglingDependency[] = [];
  for (const section of sections) {
    const missing = section.frontmatter.depends_on.filter((dependency) => !known.has(dependency));
    if (missing.length > 0) {
      dangling.push({ id: section.frontmatter.id, kind: section.frontmatter.kind, missing });
    }
  }
  return dangling;
}

function isDomain(section: MapSection): boolean {
  return section.frontmatter.kind === "domain";
}

function byId(left: MapSection, right: MapSection): number {
  return compare(left.frontmatter.id, right.frontmatter.id);
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// The first line is the section's essence: INDEX.md lists domains by it and the map listing shows it.
export function firstLineOf(body: string): string {
  const newlineIndex = body.indexOf("\n");
  return newlineIndex === -1 ? body : body.slice(0, newlineIndex);
}

function escapeTablePipes(term: string): string {
  return term.replaceAll(MARKDOWN_TABLE_PIPE, ESCAPED_TABLE_PIPE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
