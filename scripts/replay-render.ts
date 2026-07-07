import { RECALL_CANDIDATE_WINDOW } from "../src/event-schema";
import type { EventReplay, ReplayOverrides, ReplayReport } from "./replay";

// Human-readable report rendering for the replay CLI, kept apart from the replay computation in
// replay.ts so each file stays under the per-file cap (the same separation as src/mcp-rendering.ts).

const WINDOW_CAVEAT = ` (corpus exceeds the ${RECALL_CANDIDATE_WINDOW}-candidate window; analysis may be truncated)`;

export function renderVerification(report: ReplayReport): string {
  const lines = ["Replay verification", ""];
  for (const replay of report.replays) {
    lines.push(`${replay.identical ? "OK" : "MISMATCH"}  ${replay.ts ?? "unknown time"}${windowMarker(replay)}`);
  }
  lines.push("", verificationSummary(report));
  return lines.join("\n") + "\n";
}

function verificationSummary(report: ReplayReport): string {
  const verified = report.replays.filter((replay) => replay.identical).length;
  const skipped =
    report.skippedPreCandidates > 0 ? ` (${report.skippedPreCandidates} pre-candidate events skipped)` : "";
  return `${verified}/${report.replays.length} recall events reproduced${skipped}`;
}

export function renderAlternative(report: ReplayReport, overrides: ReplayOverrides): string {
  const lines = [`Replay under ${describeOverrides(overrides)}`, ""];
  for (const replay of report.replays) {
    lines.push(alternativeLine(replay));
  }
  lines.push("", `${report.replays.length} recall events replayed`);
  return lines.join("\n") + "\n";
}

function alternativeLine(replay: EventReplay): string {
  const changes = [
    replay.orderChanged ? "order changed" : "order stable",
    `entered [${replay.entered.join(", ")}]`,
    `left [${replay.left.join(", ")}]`,
  ].join("; ");
  return `${replay.ts ?? "unknown time"}: ${changes}${windowMarker(replay)}`;
}

function windowMarker(replay: EventReplay): string {
  return replay.windowLimited ? WINDOW_CAVEAT : "";
}

function describeOverrides(overrides: ReplayOverrides): string {
  const parts: string[] = [];
  if (overrides.budget !== undefined) parts.push(`budget=${overrides.budget}`);
  if (overrides.rrfK !== undefined) parts.push(`rrfK=${overrides.rrfK}`);
  if (overrides.ftsWeight !== undefined) parts.push(`ftsWeight=${overrides.ftsWeight}`);
  if (overrides.vectorWeight !== undefined) parts.push(`vectorWeight=${overrides.vectorWeight}`);
  if (overrides.stalenessWeight !== undefined) parts.push(`stalenessWeight=${overrides.stalenessWeight}`);
  return parts.join(" ");
}
