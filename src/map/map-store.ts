import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CorpusPaths } from "../corpus";
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

export function sectionDirectory(corpus: CorpusPaths, kind: MapSectionKind): string {
  return kind === "domain" ? corpus.mapDomainsDir : corpus.mapFlowsDir;
}

export function sectionPath(corpus: CorpusPaths, kind: MapSectionKind, id: string): string {
  return join(sectionDirectory(corpus, kind), `${id}${SECTION_EXTENSION}`);
}

// Domains first, then flows, each sorted by id — the order every consumer (the index, the
// derived files, the listing) sees, so no two of them disagree. A corpus provisioned before the
// map existed has no map/ yet: that is an EMPTY map, not a fault — resolveCorpus creates the
// directories on the next tool call.
export function readMapSections(corpus: CorpusPaths): MapSection[] {
  const sections: MapSection[] = [];
  for (const kind of MAP_SECTION_KINDS) {
    const directory = sectionDirectory(corpus, kind);
    if (!existsSync(directory)) continue;
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(SECTION_EXTENSION))
      .sort();
    for (const file of files) {
      sections.push(readSectionFile(join(directory, file), kind));
    }
  }
  return sections;
}

function readSectionFile(path: string, kind: MapSectionKind): MapSection {
  const section = parseMapSection(readFileSync(path, "utf8"));
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

export function writeMapSection(corpus: CorpusPaths, section: MapSection): void {
  writeFileSync(
    sectionPath(corpus, section.frontmatter.kind, section.frontmatter.id),
    serializeMapSection(section),
  );
}

// A missing file throws: the caller decides whether a section exists before asking for its removal.
export function removeMapSection(corpus: CorpusPaths, kind: MapSectionKind, id: string): void {
  rmSync(sectionPath(corpus, kind, id));
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

export function writeDerivedFiles(corpus: CorpusPaths, sections: MapSection[]): void {
  writeFileSync(corpus.mapIndexPath, renderMapIndex(sections));
  writeFileSync(corpus.glossaryPath, renderGlossary(sections));
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

function firstLineOf(body: string): string {
  const newlineIndex = body.indexOf("\n");
  return newlineIndex === -1 ? body : body.slice(0, newlineIndex);
}

function escapeTablePipes(term: string): string {
  return term.replaceAll(MARKDOWN_TABLE_PIPE, ESCAPED_TABLE_PIPE);
}
