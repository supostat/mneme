import { resolveAnchorLiveness } from "./anchor-liveness";
import { listReanchorRequests, noteReanchor } from "./curation";
import { runGit } from "./git";
import { readActiveNotes } from "./index-db";
import { NOTE_TYPES, isAnchorNeutral } from "./note";
import type { NoteType } from "./note";
import { isTracked } from "./staleness";
import type { StagingDeps } from "./staging";

// The batch stager over dead anchors: one git pass traces renames, every missing anchor of every
// anchored note is classified, and only a SINGLE confident successor is staged (through the same
// noteReanchor primitive a manual repair uses — the human gate is untouched). Ambiguity and outright
// deletion are REPORTED, never decided here, and anchor-neutral types are skipped: their anchors are
// example links that do not sink them.

export class AnchorRepairError extends Error {}

// Pinned like the staleness formula: a floor, not a tuning knob. A git rename candidate below it is
// shown to the human in the ambiguous branch (with its score), never staged. Tests stay directional
// (below the floor => ambiguous), never exact-value.
export const RENAME_SCORE_FLOOR = 75;

interface RenameEdge {
  to: string;
  score: number;
}

const RENAME_LINE = /^R(\d+)\t([^\t]+)\t(.+)$/;

// One pass over the whole history: every rename edge (old path -> new path, git similarity score),
// deduplicated on the pair keeping the best score. Chains are collapsed later, at classification.
export async function traceRenames(projectRoot: string): Promise<Map<string, RenameEdge[]>> {
  const result = await runGit(projectRoot, ["log", "-M", "--diff-filter=R", "--name-status", "--format=%H"]);
  if (result.exitCode !== 0) {
    throw new AnchorRepairError(`git log rename tracing failed: ${result.stderr.trim()}`);
  }
  const renames = new Map<string, RenameEdge[]>();
  for (const line of result.stdout.split("\n")) {
    const match = RENAME_LINE.exec(line);
    if (match === null) continue;
    const score = Number.parseInt(match[1]!, 10);
    const from = match[2]!;
    const to = match[3]!;
    const edges = renames.get(from) ?? [];
    const existing = edges.find((edge) => edge.to === to);
    if (existing === undefined) {
      edges.push({ to, score });
    } else if (score > existing.score) {
      existing.score = score;
    }
    renames.set(from, edges);
  }
  return renames;
}

export interface ScoredCandidate {
  path: string;
  score: number;
}

export type MissingAnchorClassification =
  | { kind: "unique"; newPath: string; score: number }
  | { kind: "ambiguous"; candidates: ScoredCandidate[] }
  | { kind: "none" };

// Follows the rename chain from a missing anchor. A fork (two renames out of one path) is ambiguous
// at the fork's own targets; a chain carries the MINIMUM score of its hops (the weakest link is the
// honest confidence); an endpoint that is itself gone means no successor. The rename map is
// time-agnostic, so a rename cycle (a -> b -> a: a prefix added and later removed) revisits a path;
// the chain stops at the last new path and the liveness check decides, or a live successor would
// read as an outright deletion.
export async function classifyMissingAnchor(
  projectRoot: string,
  renames: Map<string, RenameEdge[]>,
  anchor: string,
): Promise<MissingAnchorClassification> {
  let current = anchor;
  let chainScore: number | null = null;
  const visited = new Set<string>([anchor]);
  for (;;) {
    const edges = renames.get(current);
    if (edges === undefined || edges.length === 0) {
      break;
    }
    if (edges.length > 1) {
      return {
        kind: "ambiguous",
        candidates: edges.map((edge) => ({ path: edge.to, score: combineScores(chainScore, edge.score) })),
      };
    }
    const edge = edges[0]!;
    if (visited.has(edge.to)) {
      break;
    }
    visited.add(edge.to);
    chainScore = combineScores(chainScore, edge.score);
    current = edge.to;
  }
  if (current === anchor || chainScore === null) {
    return { kind: "none" };
  }
  if (!(await isTracked(projectRoot, current))) {
    return { kind: "none" };
  }
  if (chainScore < RENAME_SCORE_FLOOR) {
    return { kind: "ambiguous", candidates: [{ path: current, score: chainScore }] };
  }
  return { kind: "unique", newPath: current, score: chainScore };
}

function combineScores(accumulated: number | null, score: number): number {
  return accumulated === null ? score : Math.min(accumulated, score);
}

export interface SweepStaged {
  noteId: string;
  type: NoteType;
  oldAnchor: string;
  newAnchor: string;
  score: number;
  requestId: string;
}

export interface SweepAmbiguous {
  noteId: string;
  type: NoteType;
  oldAnchor: string;
  candidates: ScoredCandidate[];
}

export interface SweepNoSuccessor {
  noteId: string;
  type: NoteType;
  oldAnchor: string;
}

export interface SweepReport {
  staged: SweepStaged[];
  ambiguous: SweepAmbiguous[];
  noSuccessor: SweepNoSuccessor[];
  skippedNeutralN: number;
  missingByType: Record<NoteType, number>;
}

// Liveness checks and staging stay strictly sequential: unbounded parallel git spawns are a named
// debt. A note already carrying a pending request for the same anchor is skipped SILENTLY — that,
// plus repairing missing anchors only, is what keeps a re-run over a repaired corpus quiet.
export async function anchorSweep(deps: StagingDeps): Promise<SweepReport> {
  const renames = await traceRenames(deps.projectRoot);
  const pending = new Set(
    listReanchorRequests(deps.corpus).map((request) => pendingKey(request.targetId, request.oldAnchor)),
  );
  const report: SweepReport = {
    staged: [],
    ambiguous: [],
    noSuccessor: [],
    skippedNeutralN: 0,
    missingByType: emptyTypeCounts(),
  };
  for (const note of readActiveNotes(deps.corpus.notesDir)) {
    const anchors = await resolveAnchorLiveness(deps.projectRoot, note.frontmatter.anchors);
    const missing = anchors.filter((anchor) => anchor.liveness === "missing");
    if (missing.length === 0) continue;
    const noteId = note.frontmatter.id;
    const type = note.frontmatter.type;
    report.missingByType[type] += 1;
    if (isAnchorNeutral(type)) {
      report.skippedNeutralN += 1;
      continue;
    }
    for (const anchor of missing) {
      if (pending.has(pendingKey(noteId, anchor.path))) continue;
      const classified = await classifyMissingAnchor(deps.projectRoot, renames, anchor.path);
      if (classified.kind === "none") {
        report.noSuccessor.push({ noteId, type, oldAnchor: anchor.path });
      } else if (classified.kind === "ambiguous") {
        report.ambiguous.push({ noteId, type, oldAnchor: anchor.path, candidates: classified.candidates });
      } else {
        const staged = await noteReanchor(deps, noteId, anchor.path, classified.newPath, classified.score, "sweep");
        pending.add(pendingKey(noteId, anchor.path));
        report.staged.push({
          noteId,
          type,
          oldAnchor: anchor.path,
          newAnchor: classified.newPath,
          score: classified.score,
          requestId: staged.requestId,
        });
      }
    }
  }
  deps.eventWriter.append({
    type: "anchor_sweep",
    staged_n: report.staged.length,
    ambiguous_n: report.ambiguous.length,
    no_successor_n: report.noSuccessor.length,
    skipped_neutral_n: report.skippedNeutralN,
  });
  return report;
}

function pendingKey(noteId: string, anchor: string): string {
  return `${noteId}\n${anchor}`;
}

function emptyTypeCounts(): Record<NoteType, number> {
  const counts = {} as Record<NoteType, number>;
  for (const type of NOTE_TYPES) counts[type] = 0;
  return counts;
}
