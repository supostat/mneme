import { existsSync } from "node:fs";
import { relative } from "node:path";
import { createLivenessContext, resolveAnchorLiveness } from "../anchor-liveness";
import type { Corpus } from "../corpus";
import { commitPaths } from "../corpus-git";
import { refreshIndexAfterDecision } from "../index-refresh";
import type { IndexRefresh } from "../index-refresh";
import { rebuildDeps, resolveHead } from "../staging";
import type { StagingDeps } from "../staging";
import { MAP_SECTION_KINDS, isMapSectionId, parseMapSection, serializeMapSection } from "./map-section";
import type { MapSection, MapSectionKind } from "./map-section";
import {
  findDanglingDependencies,
  firstLineOf,
  readMapSections,
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
// body, anchor or term is refused with its reason before anything touches the disk.

export class MapToolError extends Error {}

export interface MapPutInput {
  kind: MapSectionKind;
  id: string;
  body: string;
  anchors: string[];
  depends_on?: string[];
  terms?: string[];
}

// What a put or a delete reports: the section it touched, the corpus commit that carries the
// change, and whether the rebuild after that commit went through (the resolve contract).
export interface MapWriteResult {
  kind: MapSectionKind;
  id: string;
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
  requireNoKindConflict(deps.corpus, section);
  writeMapSection(deps.corpus, section);
  writeDerivedFiles(deps.corpus, readMapSections(deps.corpus));
  const { id, kind } = section.frontmatter;
  const corpusCommit = await commitPaths(deps.corpus, changedPaths(deps.corpus, kind, id), `Put map ${kind} "${id}"`);
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

// `git add` of the removed path stages the deletion, so the delete rides the same commit path as
// a put; the derived files are rewritten from what remains.
export async function mapDelete(deps: StagingDeps, id: string): Promise<MapWriteResult> {
  const kind = requireExistingKind(deps.corpus, id);
  removeMapSection(deps.corpus, kind, id);
  writeDerivedFiles(deps.corpus, readMapSections(deps.corpus));
  const commit = await commitPaths(deps.corpus, changedPaths(deps.corpus, kind, id), `Delete map ${kind} "${id}"`);
  deps.eventWriter.append({ type: "map_section_deleted", id, kind, commit });
  const index = await refreshIndexAfterDecision(rebuildDeps(deps), deps.corpus.corpusDir);
  return { kind, id, commit, index };
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

// One id space for both kinds: a put that would shadow the other kind's file is refused — the
// caller deletes first, so a section never exists twice under one id.
function requireNoKindConflict(corpus: Corpus, section: MapSection): void {
  const otherKind: MapSectionKind = section.frontmatter.kind === "domain" ? "flow" : "domain";
  if (existsSync(sectionPath(corpus, otherKind, section.frontmatter.id))) {
    throw new MapToolError(`section "${section.frontmatter.id}" exists as ${otherKind}; delete it first`);
  }
}

function requireExistingKind(corpus: Corpus, id: string): MapSectionKind {
  requireSectionId(id);
  const kind = MAP_SECTION_KINDS.find((candidate) => existsSync(sectionPath(corpus, candidate, id)));
  if (kind === undefined) {
    throw new MapToolError(`no map section "${id}" exists`);
  }
  return kind;
}

// The grammar is checked before any path is joined from the id (the readNote precedent).
function requireSectionId(id: string): void {
  if (!isMapSectionId(id)) {
    throw new MapToolError(`invalid map section id: ${JSON.stringify(id)}`);
  }
}

// The section file plus the two derived files, as the corpus repository addresses them.
function changedPaths(corpus: Corpus, kind: MapSectionKind, id: string): string[] {
  return [sectionPath(corpus, kind, id), corpus.mapIndexPath, corpus.glossaryPath].map((path) =>
    relative(corpus.corpusDir, path),
  );
}
