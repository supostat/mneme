import { existsSync } from "node:fs";
import { relative } from "node:path";
import { createLivenessContext, resolveAnchorLiveness } from "../anchor-liveness";
import type { Corpus } from "../corpus";
import { commitPaths, trackedPaths } from "../corpus-git";
import { refreshIndexAfterDecision } from "../index-refresh";
import type { IndexRefresh } from "../index-refresh";
import { rebuildDeps, resolveHead } from "../staging";
import type { StagingDeps } from "../staging";
import { MAP_SECTION_KINDS, isMapSectionId, parseMapSection, serializeMapSection } from "./map-section";
import type { MapSection, MapSectionKind } from "./map-section";
import {
  findDanglingDependencies,
  firstLineOf,
  listSectionFiles,
  readMapSections,
  readSectionFiles,
  removeMapSection,
  sectionPath,
  writeDerivedFiles,
  writeMapSection,
} from "./map-store";
import type { DanglingDependency } from "./map-store";

// The map's write surface. No human gate: the map is a synthetic layer the plugin rebuilds, so a
// put or a delete goes straight to map/, rewrites the two derived files, commits the corpus, logs
// one event and refreshes the index — through the same commit and refresh mechanics a staging
// decision uses, never a second copy. Validation is fail-closed at the boundary: a bad id, kind,
// body, anchor or term is refused with its reason before anything touches the disk, and so is a
// map that does not read — a broken file or an id held by both kinds — since the derived files are
// rewritten from it. Every write survives a retry after a failed commit.

export class MapToolError extends Error {}

export interface MapPutInput {
  kind: MapSectionKind;
  id: string;
  body: string;
  anchors: string[];
  depends_on?: string[];
  terms?: string[];
}

// What a put reports: the section it touched, the corpus commit that carries the change, and
// whether the rebuild after that commit went through (the resolve contract).
export interface MapWriteResult {
  kind: MapSectionKind;
  id: string;
  commit: string;
  index: IndexRefresh;
}

// A delete reports every kind it removed: one, or both when a corrupted map held the id twice.
export interface MapDeleteResult {
  id: string;
  kinds: MapSectionKind[];
  commit: string;
  index: IndexRefresh;
}

export interface MapListEntry {
  id: string;
  kind: MapSectionKind;
  firstLine: string;
  anchorsN: number;
  deadN: number;
  dependsOn: string[];
  termsN: number;
}

export interface MapListResult {
  entries: MapListEntry[];
  dangling: DanglingDependency[];
}

export async function mapPut(deps: StagingDeps, input: MapPutInput): Promise<MapWriteResult> {
  const commit = await resolveHead(deps.projectRoot);
  // The document is assembled and parsed back as the exact text the store will hold: what the
  // parser accepts is what lands on disk, so a put can never write a section a rebuild would refuse.
  const section = parseMapSection(
    serializeMapSection({
      frontmatter: {
        id: input.id,
        kind: input.kind,
        anchors: input.anchors,
        depends_on: input.depends_on ?? [],
        terms: input.terms ?? [],
        commit,
      },
      body: input.body,
    }),
  );
  const { id, kind } = section.frontmatter;
  const existing = readMapSections(deps.corpus);
  requireNoKindConflict(existing, section);
  writeMapSection(deps.corpus, section);
  writeDerivedFiles(deps.corpus, [...existing.filter((stored) => stored.frontmatter.id !== id), section]);
  const corpusCommit = await commitPaths(
    deps.corpus,
    [sectionRelativePath(deps.corpus, kind, id), ...derivedRelativePaths(deps.corpus)],
    `Put map ${kind} "${id}"`,
  );
  deps.eventWriter.append({
    type: "map_section_put",
    id,
    kind,
    body_len: [...section.body].length,
    anchors_n: section.frontmatter.anchors.length,
    depends_on_n: section.frontmatter.depends_on.length,
    terms_n: section.frontmatter.terms.length,
    commit: corpusCommit,
  });
  const index = await refreshIndexAfterDecision(rebuildDeps(deps), deps.corpus.corpusDir);
  return { kind, id, commit: corpusCommit, index };
}

// An id exists while its file is on disk OR the corpus repository still tracks it: a delete whose
// commit failed has removed the file already, and its retry must finish the commit rather than
// answer "no map section". The rest of the map is read BEFORE anything is removed, leaving every
// file of this id out — so a delete stays the remedy for an unreadable file of its own id and for
// an id held by both kinds, while any other broken file refuses it with nothing changed. `git add`
// of a removed path stages the deletion, but only a path git knows can be added: a file a failed
// put never committed is removed and left out of the commit.
export async function mapDelete(deps: StagingDeps, id: string): Promise<MapDeleteResult> {
  requireSectionId(id);
  const sectionPaths = new Map(MAP_SECTION_KINDS.map((kind) => [kind, sectionRelativePath(deps.corpus, kind, id)]));
  const tracked = await trackedPaths(deps.corpus, [...sectionPaths.values()]);
  const kinds = MAP_SECTION_KINDS.filter(
    (kind) => existsSync(sectionPath(deps.corpus, kind, id)) || tracked.has(sectionPaths.get(kind)!),
  );
  if (kinds.length === 0) {
    throw new MapToolError(`no map section "${id}" exists`);
  }
  const remaining = readSectionFiles(listSectionFiles(deps.corpus).filter((file) => file.id !== id));
  for (const kind of kinds) {
    if (existsSync(sectionPath(deps.corpus, kind, id))) removeMapSection(deps.corpus, kind, id);
  }
  writeDerivedFiles(deps.corpus, remaining);
  const removedTrackedPaths = kinds.map((kind) => sectionPaths.get(kind)!).filter((path) => tracked.has(path));
  const commit = await commitPaths(
    deps.corpus,
    [...removedTrackedPaths, ...derivedRelativePaths(deps.corpus)],
    `Delete map ${kinds.join(" and ")} "${id}"`,
  );
  for (const kind of kinds) {
    deps.eventWriter.append({ type: "map_section_deleted", id, kind, commit });
  }
  const index = await refreshIndexAfterDecision(rebuildDeps(deps), deps.corpus.corpusDir);
  return { id, kinds, commit, index };
}

// Domains first, then flows, by id — the store's order. Liveness is resolved exactly as notes_list
// does it: one branch-tips context for the whole listing, a dead anchor is a missing one.
export async function mapList(deps: StagingDeps): Promise<MapListResult> {
  const sections = readMapSections(deps.corpus);
  const context = await createLivenessContext(deps.projectRoot);
  const entries: MapListEntry[] = [];
  for (const section of sections) {
    const anchors = await resolveAnchorLiveness(context, section.frontmatter.anchors);
    entries.push({
      id: section.frontmatter.id,
      kind: section.frontmatter.kind,
      firstLine: firstLineOf(section.body),
      anchorsN: anchors.length,
      deadN: anchors.filter((anchor) => anchor.liveness === "missing").length,
      dependsOn: section.frontmatter.depends_on,
      termsN: section.frontmatter.terms.length,
    });
  }
  return { entries, dangling: findDanglingDependencies(sections) };
}

// Read through the store, so a section whose file disagrees with its frontmatter is a named error
// here exactly as it is for the rebuild and the doctor.
export function showMapSection(corpus: Corpus, id: string): MapSection {
  requireSectionId(id);
  const section = readMapSections(corpus).find((candidate) => candidate.frontmatter.id === id);
  if (section === undefined) {
    throw new MapToolError(`no map section "${id}" exists`);
  }
  return section;
}

// One id space for both kinds: a put that would shadow the other kind's section is refused — the
// caller deletes first, so a section never exists twice under one id.
function requireNoKindConflict(existing: MapSection[], section: MapSection): void {
  const { id, kind } = section.frontmatter;
  const other = existing.find((stored) => stored.frontmatter.id === id && stored.frontmatter.kind !== kind);
  if (other !== undefined) {
    throw new MapToolError(`section "${id}" exists as ${other.frontmatter.kind}; delete it first`);
  }
}

// The grammar is checked before any path is joined from the id (the readNote precedent).
function requireSectionId(id: string): void {
  if (!isMapSectionId(id)) {
    throw new MapToolError(`invalid map section id: ${JSON.stringify(id)}`);
  }
}

// Paths as the corpus repository addresses them.
function sectionRelativePath(corpus: Corpus, kind: MapSectionKind, id: string): string {
  return relative(corpus.corpusDir, sectionPath(corpus, kind, id));
}

function derivedRelativePaths(corpus: Corpus): string[] {
  return [corpus.mapIndexPath, corpus.glossaryPath].map((path) => relative(corpus.corpusDir, path));
}
