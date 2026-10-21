import { MAX_BODY_CODE_POINTS } from "../note";
import { findForbiddenMarkup } from "../sanitize-body";
import type { RememberInput } from "../staging";

// A harvest artifact is a phase's distilled knowledge in one of three fixed templates. This module
// owns how an artifact becomes a note body and whether that body may be staged at all — checked for
// EVERY artifact before the first one is staged, so a refused harvest leaves nothing behind.

export class HarvestArtifactError extends Error {}

export const HARVEST_SOURCE = "harvest";

export const HARVEST_BODY_LIMIT_RULE =
  `each harvest artifact's body — its template prefix included — must fit ${MAX_BODY_CODE_POINTS} ` +
  "code points; an artifact over it refuses the whole harvest and nothing is staged";

export type PhaseArtifact =
  | { kind: "fixed_test"; test: string; failure: string; fix: string; anchors: string[] }
  | { kind: "resolved_error"; error: string; resolution: string; anchors: string[] }
  | { kind: "decision"; decision: string; rationale: string; anchors: string[] };

// One label per template field, in field order. The first label opens the body, so its first line is
// non-empty by construction; the labels' own length is the share of the limit an artifact never gets.
const TEMPLATE_LABELS: Record<PhaseArtifact["kind"], readonly string[]> = {
  fixed_test: ["Fixed failing test: ", "\nFailure: ", "\nFix: "],
  resolved_error: ["Resolved error: ", "\nResolution: "],
  decision: ["Decision: ", "\nRationale: "],
};

export function validateArtifact(artifact: PhaseArtifact): void {
  for (const field of templateFieldsOf(artifact)) {
    if (typeof field !== "string") {
      throw new HarvestArtifactError(`a ${artifact.kind} artifact requires string template fields`);
    }
  }
  if (primaryTextOf(artifact).trim() === "") {
    throw new HarvestArtifactError(`a ${artifact.kind} artifact requires non-empty primary text`);
  }
  if (artifact.anchors.length === 0) {
    throw new HarvestArtifactError(`a ${artifact.kind} artifact requires at least one anchor`);
  }
}

// The same two checks remember applies, run up front over the whole harvest: a body over the limit
// or carrying foreign markup refuses every artifact, never just the ones after it.
export function assertArtifactBodiesFit(artifacts: PhaseArtifact[]): void {
  artifacts.forEach((artifact, index) => {
    const position = index + 1;
    const body = bodyOf(artifact);
    const marker = findForbiddenMarkup(body);
    if (marker !== null) {
      throw new HarvestArtifactError(
        `harvest artifact ${position} (${artifact.kind}) contains foreign tool/protocol markup: ${marker}; ` +
          "nothing was staged",
      );
    }
    const length = codePointLength(body);
    if (length > MAX_BODY_CODE_POINTS) {
      throw new HarvestArtifactError(
        `harvest artifact ${position} (${artifact.kind}) renders to ${length} code points — ` +
          `${length - MAX_BODY_CODE_POINTS} over the ${MAX_BODY_CODE_POINTS} limit ` +
          `(the template prefix takes ${templatePrefixLength(artifact.kind)}); nothing was staged`,
      );
    }
  });
}

export function rememberInputFrom(artifact: PhaseArtifact): RememberInput {
  return {
    type: artifact.kind === "decision" ? "decision" : "bugfix",
    body: bodyOf(artifact),
    anchors: artifact.anchors,
    source: HARVEST_SOURCE,
  };
}

function bodyOf(artifact: PhaseArtifact): string {
  const fields = templateFieldsOf(artifact);
  return TEMPLATE_LABELS[artifact.kind].map((label, index) => `${label}${fields[index]}`).join("");
}

function templatePrefixLength(kind: PhaseArtifact["kind"]): number {
  return TEMPLATE_LABELS[kind].reduce((total, label) => total + codePointLength(label), 0);
}

// The limit counts code points, not UTF-16 units: an astral character is one code point but two units.
function codePointLength(text: string): number {
  return [...text].length;
}

// Artifacts arrive from agent output, so the union is a compile-time claim only: the kind is checked
// exhaustively at runtime before any template field is touched.
function templateFieldsOf(artifact: PhaseArtifact): string[] {
  if (artifact.kind === "fixed_test") return [artifact.test, artifact.failure, artifact.fix];
  if (artifact.kind === "resolved_error") return [artifact.error, artifact.resolution];
  if (artifact.kind === "decision") return [artifact.decision, artifact.rationale];
  throw new HarvestArtifactError(`unknown artifact kind: ${String((artifact as { kind: unknown }).kind)}`);
}

function primaryTextOf(artifact: PhaseArtifact): string {
  if (artifact.kind === "fixed_test") return artifact.test;
  if (artifact.kind === "resolved_error") return artifact.error;
  return artifact.decision;
}
