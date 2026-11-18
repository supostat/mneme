import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readEvents } from "../events";
import { textResult } from "../mcp-rendering";
import type { StagingDeps } from "../staging";
import { MigratedSpecError, migratedSpecSlugs, readMigratedSpec } from "./migrated-spec";
import { PhaseGraphValidationError, buildPhaseGraph } from "./phase-graph";
import { lookUpRun, renderRunLookupMiss } from "./run-lookup";
import {
  BOTH_SELECTORS_TEXT,
  renderMigratedSpec,
  renderMigratedSpecList,
  renderRunSpec,
  renderSpecRefusal,
} from "./spec-rendering";

// The read-only workflow_spec tool: what spec a run started from, what a migrated spec holds now, and
// which specs are migrated — read through the engine's own corpus, so a caller never builds a corpus
// path. Its deps carry no EventWriter, so "writes nothing" is a property of the types; every answer
// that is not the spec — an id outside the grammar, an unknown or unreadable run, an unknown slug, a
// file that does not parse, both selectors at once — is plain text, never a throw, because the
// server's dispatch logs a tool_error on a throw and this tool leaves the log as it found it.

export const WORKFLOW_SPEC_DESCRIPTION =
  "Read a spec WITHOUT side effects: it reads the event log and the corpus and writes NOTHING — no " +
  "event, no file, no stale mark. With run_id: the spec the run (of any branch, finished or still " +
  "running) started from — a line naming its migrated spec slug and the project HEAD at start, the " +
  "spec's Knowledge as the start read it from the spec archive (bullets as from-spec folds them: a " +
  "continuation line joined to its bullet with one space, comments dropped), and every phase with its " +
  "deps and its done-when criteria exactly as the run's gates checked them; a run started from phase " +
  "texts says so, and a run started before schema v25 reads as not recorded. With spec_slug: the " +
  "migrated spec as it is in this corpus now — its archive's Knowledge and its phases with their " +
  "done-when. With neither: the migrated specs of this corpus with their phase counts. Pass run_id or " +
  "spec_slug, never both.";

export const WORKFLOW_SPEC_INPUT = {
  run_id: z.string().optional(),
  spec_slug: z.string().optional(),
};

export interface WorkflowSpecArgs {
  run_id?: string;
  spec_slug?: string;
}

export type SpecToolDeps = Pick<StagingDeps, "corpus">;

export function workflowSpecTool(deps: SpecToolDeps, args: WorkflowSpecArgs): CallToolResult {
  if (args.run_id !== undefined && args.spec_slug !== undefined) return textResult(BOTH_SELECTORS_TEXT);
  if (args.run_id !== undefined) return textResult(runSpecAnswer(deps, args.run_id));
  if (args.spec_slug !== undefined) return textResult(migratedSpecAnswer(deps, args.spec_slug));
  return textResult(renderMigratedSpecList(migratedSpecSlugs(deps.corpus.corpusDir)));
}

function runSpecAnswer(deps: SpecToolDeps, runId: string): string {
  const lookup = lookUpRun(readEvents(deps.corpus.eventsDir), runId);
  return lookup.kind === "found" ? renderRunSpec(lookup.run) : renderRunLookupMiss(lookup);
}

// A folder edited by hand can name an unknown dependency or close a cycle: the graph is built exactly
// as a start would build it, and its refusal is an answer like any other read refusal.
function migratedSpecAnswer(deps: SpecToolDeps, slug: string): string {
  try {
    const spec = readMigratedSpec(deps.corpus.corpusDir, slug);
    return renderMigratedSpec(spec.slug, spec.knowledge, buildPhaseGraph(spec.documents));
  } catch (error) {
    if (error instanceof MigratedSpecError) return renderSpecRefusal(error.message);
    if (error instanceof PhaseGraphValidationError) {
      return renderSpecRefusal(`the phases of migrated spec "${slug}" do not form a graph: ${error.message}`);
    }
    throw error;
  }
}
