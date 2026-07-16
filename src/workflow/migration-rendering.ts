import type { MigrationPlan, MigrationReport } from "./migration";
import type { PhaseDocument } from "./phase-document";

// Renders the migration surfaces — the workflow_migrate MCP tool and scripts/migrate.ts — so both
// speak one manifest, one launch line and one graph map. Kept apart from migration.ts, which stays a
// pure plan/apply library free of presentation (the run-directives.ts split, mirrored). Every string
// is plain ASCII by contract: these envelopes travel through stdio MCP responses where exotic
// separators (U+2028/U+2029/U+0085) break the frame. Sections carry no trailing newline; the caller
// joins them.

export function renderMigrationManifest(plan: MigrationPlan): string {
  const lines = [`Phase-file plan -> ${plan.workflowDir}`];
  for (const write of plan.writes) {
    lines.push(`  ${write.action.padEnd(9)} ${write.relativePath} (${write.bytes} bytes)`);
  }
  return lines.join("\n");
}

export function renderPathList(header: string, paths: string[]): string {
  return [header, ...paths.map((path) => `  ${path}`)].join("\n");
}

// The convenience launch line. A single-phase plan names the one phase file; a multi-phase plan names
// the whole spec directory, which /mneme:dev reads as one run (it assembles every phase-*.md in the
// directory into a single multi-phase start).
export function renderRunCommand(plan: MigrationPlan): string {
  const paths = plan.writes.map((write) => write.absolutePath);
  const [entry] = paths;
  if (entry === undefined) {
    return "";
  }
  if (paths.length === 1) {
    return `Run it with:\n  /mneme:dev ${entry}`;
  }
  return `Run the whole task with:\n  /mneme:dev ${plan.workflowDir}`;
}

// The graph map: what the reducer will sequence (ready-order by deps) and what each phase is gated
// on. This is the migration response's only view of the graph, so a caller planning the run never has
// to re-read and re-parse the phase files it just wrote.
export function renderPhaseGraph(documents: PhaseDocument[]): string {
  const lines = ["Phase graph:"];
  for (const document of documents) {
    lines.push(`  ${document.id} deps: [${document.deps.join(", ")}] done-when: ${criterionKinds(document)}`);
  }
  return lines.join("\n");
}

function criterionKinds(document: PhaseDocument): string {
  return document.doneWhen.map((criterion) => criterion.kind).join(", ");
}

export function createdAbsolutePaths(plan: MigrationPlan, report: MigrationReport): string[] {
  const absoluteByRelative = new Map(plan.writes.map((write) => [write.relativePath, write.absolutePath]));
  return report.created
    .map((relativePath) => absoluteByRelative.get(relativePath))
    .filter((path): path is string => path !== undefined);
}

export function conflictingPhaseIds(plan: MigrationPlan): string[] {
  return plan.writes.filter((write) => write.action === "conflict").map((write) => write.phaseId);
}
