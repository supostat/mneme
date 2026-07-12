import type { PhaseDocument } from "./phase-document";

export class PhaseGraphValidationError extends Error {}

export type PhaseStatus = "pending" | "closed";

export interface PhaseGraph {
  phases: Record<string, PhaseDocument>;
}

export function buildPhaseGraph(documents: PhaseDocument[]): PhaseGraph {
  if (documents.length === 0) {
    throw new PhaseGraphValidationError("a phase graph requires at least one phase document");
  }
  const phasesById = new Map<string, PhaseDocument>();
  for (const document of documents) {
    if (phasesById.has(document.id)) {
      throw new PhaseGraphValidationError(`duplicate phase id: ${document.id}`);
    }
    phasesById.set(document.id, document);
  }
  for (const document of documents) {
    for (const dependencyId of document.deps) {
      if (!phasesById.has(dependencyId)) {
        throw new PhaseGraphValidationError(
          `phase "${document.id}" depends on unknown phase "${dependencyId}"`,
        );
      }
    }
  }
  rejectDependencyCycles(phasesById);
  return { phases: Object.fromEntries(phasesById) };
}

type VisitState = "visiting" | "visited";

function rejectDependencyCycles(phasesById: Map<string, PhaseDocument>): void {
  const visitStates = new Map<string, VisitState>();
  for (const phaseId of phasesById.keys()) {
    if (!visitStates.has(phaseId)) {
      visitDependencies(phaseId, phasesById, visitStates);
    }
  }
}

interface DependencyFrame {
  document: PhaseDocument;
  dependencyIndex: number;
}

function visitDependencies(
  phaseId: string,
  phasesById: Map<string, PhaseDocument>,
  visitStates: Map<string, VisitState>,
): void {
  visitStates.set(phaseId, "visiting");
  const stack: DependencyFrame[] = [frameFor(phaseId, phasesById)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      throw new Error("dependency traversal stack emptied mid-iteration");
    }
    const dependencyId = frame.document.deps[frame.dependencyIndex];
    if (dependencyId === undefined) {
      visitStates.set(frame.document.id, "visited");
      stack.pop();
      continue;
    }
    frame.dependencyIndex += 1;
    const dependencyState = visitStates.get(dependencyId);
    if (dependencyState === "visiting") {
      throw new PhaseGraphValidationError(`dependency cycle through phase "${dependencyId}"`);
    }
    if (dependencyState === undefined) {
      visitStates.set(dependencyId, "visiting");
      stack.push(frameFor(dependencyId, phasesById));
    }
  }
}

function frameFor(phaseId: string, phasesById: Map<string, PhaseDocument>): DependencyFrame {
  const document = phasesById.get(phaseId);
  if (document === undefined) {
    throw new Error(`phase "${phaseId}" disappeared during cycle detection`);
  }
  return { document, dependencyIndex: 0 };
}

export function readyPhaseIds(graph: PhaseGraph, statuses: Record<string, PhaseStatus>): string[] {
  const ready: string[] = [];
  for (const phase of Object.values(graph.phases)) {
    const isPending = statuses[phase.id] === "pending";
    const allDependenciesClosed = phase.deps.every(
      (dependencyId) => statuses[dependencyId] === "closed",
    );
    if (isPending && allDependenciesClosed) {
      ready.push(phase.id);
    }
  }
  return ready.sort();
}

export function selectNextReadyPhase(
  graph: PhaseGraph,
  statuses: Record<string, PhaseStatus>,
): string | null {
  return readyPhaseIds(graph, statuses)[0] ?? null;
}
