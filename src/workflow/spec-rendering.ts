import { singleLine } from "../single-line";
import type { MigratedSpecSummary } from "./migrated-spec";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";
import type { PhaseGraph } from "./phase-graph";
import type { ReadableRun } from "./run-events";
import { NOT_WRITTEN } from "./run-lookup";
import type { RunProvenance } from "./run-payloads";
import { READ_ONLY_NOTICE } from "./run-survey-rendering";

// The plain-text answers of workflow_spec and the spec line diary_facts shares with it. Every line
// has a fixed shape a skill parses, so every piece of stored text — a Knowledge bullet, a criterion,
// a command, a branch — is folded onto one line first. Phases are listed so that each comes after
// its dependencies, ties broken by id, whatever order the graph was built in.

const SEPARATOR = " · ";

export const SPEC_NONE_SEGMENT = "spec none";
export const SPEC_NOT_RECORDED_SEGMENT = "spec not recorded";
export const BASE_COMMIT_NONE_SEGMENT = "base commit none";
export const BASE_COMMIT_NOT_RECORDED_SEGMENT = "base commit not recorded";
export const KNOWLEDGE_HEADER = "knowledge:";
export const KNOWLEDGE_INLINE_LINE = "knowledge: none — phases were passed as text";
export const KNOWLEDGE_NOT_RECORDED_LINE = "knowledge: not recorded — the run started before schema v25";
export const NO_SPEC_MIGRATED_TEXT = `No spec is migrated in this corpus. ${NOT_WRITTEN}`;
export const BOTH_SELECTORS_TEXT = `pass run_id or spec_slug, not both. ${NOT_WRITTEN}`;
export const DEPS_NONE = "none";

export function renderSpecLine(provenance: RunProvenance | null): string {
  return `${specSegment(provenance)}${SEPARATOR}${baseCommitSegment(provenance)}`;
}

export function renderRunSpec(run: ReadableRun): string {
  return [
    `Spec of run ${run.runId} on branch "${singleLine(run.branch)}". ${READ_ONLY_NOTICE}`,
    renderSpecLine(run.provenance),
    ...runKnowledgeLines(run.provenance),
    ...phaseLines(run.definition.graph),
  ].join("\n");
}

export function renderMigratedSpec(slug: string, knowledge: string[] | null, graph: PhaseGraph): string {
  return [
    `Migrated spec "${slug}" as it is in this corpus now. ${READ_ONLY_NOTICE}`,
    ...(knowledge === null ? [`knowledge: none — specs/${slug}.md is absent`] : knowledgeBlock(knowledge)),
    ...phaseLines(graph),
  ].join("\n");
}

export function renderMigratedSpecList(summaries: MigratedSpecSummary[]): string {
  if (summaries.length === 0) return NO_SPEC_MIGRATED_TEXT;
  return [
    `Migrated specs in this corpus: ${summaries.length}. ${READ_ONLY_NOTICE}`,
    ...summaries.map((summary) => `- ${summary.slug}${SEPARATOR}${summary.phaseCount} ${summary.phaseCount === 1 ? "phase" : "phases"}`),
  ].join("\n");
}

// A refusal of the read — a slug outside the grammar, an unknown slug, a file that does not parse —
// answered as text that names it, so the read stays a non-event.
export function renderSpecRefusal(reason: string): string {
  return `${singleLine(reason)}. ${NOT_WRITTEN}`;
}

function specSegment(provenance: RunProvenance | null): string {
  if (provenance === null) return SPEC_NOT_RECORDED_SEGMENT;
  return provenance.spec.kind === "spec" ? `spec ${singleLine(provenance.spec.slug)}` : SPEC_NONE_SEGMENT;
}

function baseCommitSegment(provenance: RunProvenance | null): string {
  if (provenance === null) return BASE_COMMIT_NOT_RECORDED_SEGMENT;
  return provenance.baseCommit.kind === "commit"
    ? `base commit ${singleLine(provenance.baseCommit.sha)}`
    : BASE_COMMIT_NONE_SEGMENT;
}

function runKnowledgeLines(provenance: RunProvenance | null): string[] {
  if (provenance === null) return [KNOWLEDGE_NOT_RECORDED_LINE];
  if (provenance.spec.kind === "inline") return [KNOWLEDGE_INLINE_LINE];
  if (provenance.spec.knowledge === null) {
    return [`knowledge: none — specs/${singleLine(provenance.spec.slug)}.md was absent at start`];
  }
  return knowledgeBlock(provenance.spec.knowledge);
}

function knowledgeBlock(knowledge: string[]): string[] {
  return [KNOWLEDGE_HEADER, ...knowledge.map((bullet) => `- ${singleLine(bullet)}`)];
}

function phaseLines(graph: PhaseGraph): string[] {
  return phasesInDependencyOrder(graph).flatMap((phase) => [
    `phase ${phase.id}${SEPARATOR}deps ${phase.deps.length === 0 ? DEPS_NONE : phase.deps.join(", ")}`,
    ...phase.doneWhen.map(criterionLine),
  ]);
}

function criterionLine(criterion: DoneWhenCriterion): string {
  if (criterion.kind === "executable") {
    return `- executable: ${singleLine(criterion.command)} — ${singleLine(criterion.description)}`;
  }
  return `- agent-judged: ${singleLine(criterion.description)}`;
}

// The graph was validated acyclic when it was built, so some remaining phase is always ready.
function phasesInDependencyOrder(graph: PhaseGraph): PhaseDocument[] {
  const remaining = Object.values(graph.phases).sort((left, right) => (left.id < right.id ? -1 : 1));
  const placed = new Set<string>();
  const ordered: PhaseDocument[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((phase) => phase.deps.every((dependency) => placed.has(dependency)));
    const next = remaining[index];
    if (next === undefined) throw new Error("a validated phase graph left no phase ready");
    remaining.splice(index, 1);
    placed.add(next.id);
    ordered.push(next);
  }
  return ordered;
}
