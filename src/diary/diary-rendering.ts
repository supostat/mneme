import { READ_ONLY_NOTICE } from "../workflow/run-survey-rendering";
import type { PhaseFacts, PhaseHarvest, RunFacts, RunFactsAnswer, TerminalRunRef } from "./diary-run-facts";
import type { SessionFacts } from "./diary-session-facts";

// The diary's plain-text answers: the full run and session forms the diary skill reads, the
// non-answers that stand in for an error (an error would be logged, and this path writes nothing),
// and the ONE brief line the diary_facts tool and the `mneme diary --brief` CLI both print. Every
// piece of free text that comes out of the log — a query, a criterion, a remark, a reason — is
// folded onto one line first, so no stored string can break the line structure a reader parses.

export const DIARY_LINE_PREFIX = "diary: ";
export const DIARY_BRIEF_NOTHING = "diary: nothing to note";
export const MAX_BRIEF_GAPS = 5;
export const MAX_BRIEF_QUERY_CODE_POINTS = 80;
export const NOT_WRITTEN = "Nothing was written.";
export const RUN_ID_INVALID_TEXT = `run_id is not a ULID or UUID. ${NOT_WRITTEN}`;
export const BRIEF_WITH_RUN_ID_TEXT = `brief describes the session only: pass brief or run_id, not both. ${NOT_WRITTEN}`;

const SEPARATOR = " · ";
const UNKNOWN_TS = "unknown";
const NOT_INSTRUMENTED = "not instrumented";
const NOT_RUN = "not run";
const CLIP_MARK = "…";

export type BranchTerminal =
  | { kind: "branch"; branch: string; lastTerminal: TerminalRunRef | null }
  | { kind: "detached" }
  | { kind: "git-error" };

// The gap segment's source: the one session whose facts the line describes, no live session at all,
// or several live sessions the CLI cannot tell apart.
export type BriefGaps =
  | { kind: "session"; facts: SessionFacts }
  | { kind: "no-live-session" }
  | { kind: "shared"; liveSessions: number };

export function renderRunAnswer(answer: RunFactsAnswer): string {
  if (answer.kind === "invalid-id") return RUN_ID_INVALID_TEXT;
  if (answer.kind === "unknown") return `No workflow run ${answer.runId} in this corpus. ${NOT_WRITTEN}`;
  if (answer.kind === "unreadable") {
    return `Run ${answer.runId} cannot be read from the log: ${singleLine(answer.problem)}. ${NOT_WRITTEN}`;
  }
  if (answer.kind === "running") {
    return (
      `Run ${answer.runId} is still running on branch "${singleLine(answer.branch)}": ` +
      `diary facts describe a finished run. ${NOT_WRITTEN}`
    );
  }
  return renderRunFacts(answer.facts);
}

function renderRunFacts(facts: RunFacts): string {
  const curation = facts.curation;
  return [
    `Diary facts for run ${facts.runId} on branch "${singleLine(facts.branch)}". ${READ_ONLY_NOTICE}`,
    `status ${facts.status}${SEPARATOR}started ${facts.startedTs}${SEPARATOR}ended ${facts.endedTs ?? UNKNOWN_TS}` +
      `${SEPARATOR}iterations ${facts.iterationsUsed}/${facts.maxIterations}`,
    `diary entry: ${facts.diaryEntry ? "present" : "none"}`,
    ...(facts.escalation === null
      ? []
      : [`escalation: ${facts.escalation.phaseId}/${facts.escalation.stepId} — ${singleLine(facts.escalation.reason)}`]),
    `curation: staged ${curation.staged}${SEPARATOR}accepted ${curation.accepted}${SEPARATOR}` +
      `rejected ${curation.rejected}${SEPARATOR}superseded ${curation.superseded}`,
    ...(curation.uninstrumentedHarvests === 0
      ? []
      : [`curation: ${curation.uninstrumentedHarvests} harvest(s) before schema v22 not counted`]),
    ...facts.phases.flatMap(renderPhase),
  ].join("\n");
}

function renderPhase(phase: PhaseFacts): string[] {
  if (!phase.reached) return [`phase ${phase.phaseId}: not reached`];
  const bundleGap = phase.bundleGap === null ? NOT_INSTRUMENTED : phase.bundleGap ? "yes" : "no";
  return [
    `phase ${phase.phaseId}: attempts ${phase.attempts}${SEPARATOR}bundle gap ${bundleGap}` +
      `${SEPARATOR}harvest ${renderHarvestKinds(phase.harvest)}${SEPARATOR}used notes ${renderUsedNotes(phase.harvest)}`,
    ...phase.gateFailures.flatMap((failure) => [
      `  gate fail${SEPARATOR}attempt ${failure.attempt}${SEPARATOR}${failure.kind}${SEPARATOR}` +
        `${singleLine(failure.criterion)}${SEPARATOR}${failure.reason}`,
      ...failure.remarks.map((remark) => `  remark: ${singleLine(remark)}`),
    ]),
  ];
}

function renderHarvestKinds(harvest: PhaseHarvest): string {
  if (harvest.kind === "not-run") return NOT_RUN;
  if (harvest.stagedByType === null) {
    return harvest.harvestedCount === null
      ? `kinds ${NOT_INSTRUMENTED}`
      : `${harvest.harvestedCount} staged, kinds ${NOT_INSTRUMENTED}`;
  }
  if (harvest.stagedByType.length === 0) return "none";
  return harvest.stagedByType.map((entry) => `${entry.type} ${entry.count}`).join(", ");
}

function renderUsedNotes(harvest: PhaseHarvest): string {
  if (harvest.kind === "not-run") return NOT_RUN;
  return harvest.usedNotes === null ? NOT_INSTRUMENTED : String(harvest.usedNotes);
}

export function renderSessionFacts(facts: SessionFacts, terminal: BranchTerminal): string {
  const gapLines =
    facts.gaps.length === 0
      ? ["memory gaps: none"]
      : [
          "memory gaps, oldest first:",
          ...facts.gaps.map((gap) => `- ${gap.ts ?? UNKNOWN_TS} "${singleLine(gap.query)}"${gap.open ? " (open)" : ""}`),
        ];
  return [
    `Diary facts for session ${facts.sessionId}. ${READ_ONLY_NOTICE}`,
    `recalls ${facts.recalls}${SEPARATOR}memory gaps ${facts.gaps.length}${SEPARATOR}notes ${facts.notes}`,
    ...gapLines,
    renderBranchTerminal(terminal),
  ].join("\n");
}

function renderBranchTerminal(terminal: BranchTerminal): string {
  if (terminal.kind === "detached") return "HEAD is detached: no branch to look up a terminal run on.";
  if (terminal.kind === "git-error") return "git failed to resolve the current branch: no terminal run to look up.";
  const last = terminal.lastTerminal;
  if (last === null) return `no terminal run on branch "${terminal.branch}"`;
  const entry = last.diaryEntry ? "has a diary entry" : "without a diary entry";
  return `last terminal run on branch "${terminal.branch}": ${last.runId} [${last.status}] ${entry}`;
}

// The one line a prompt hook injects: only the segments that have something to say, or null when
// none has. The run segment names the branch's newest finished run while it lacks an entry; the gap
// segment names the newest open gaps — the cap keeps a long session from flooding every prompt.
export function renderDiaryLine(lastTerminal: TerminalRunRef | null, gaps: BriefGaps): string | null {
  const segments = [runSegment(lastTerminal), gapSegment(gaps)].filter((segment): segment is string => segment !== null);
  return segments.length === 0 ? null : `${DIARY_LINE_PREFIX}${segments.join(SEPARATOR)}`;
}

function runSegment(lastTerminal: TerminalRunRef | null): string | null {
  if (lastTerminal === null || lastTerminal.diaryEntry) return null;
  return `run ${lastTerminal.runId} ${lastTerminal.status} without a diary entry`;
}

function gapSegment(gaps: BriefGaps): string | null {
  if (gaps.kind === "no-live-session") return null;
  if (gaps.kind === "shared") return `memory gaps: n/a — ${gaps.liveSessions} live sessions share this corpus`;
  const open = gaps.facts.gaps.filter((gap) => gap.open);
  if (open.length === 0) return null;
  const shown = open.slice(-MAX_BRIEF_GAPS);
  const quoted = shown.map((gap) => `"${clipForBrief(singleLine(gap.query))}"`).join(", ");
  const earlier = open.length - shown.length;
  return `memory gaps since the last note: ${quoted}${earlier === 0 ? "" : ` (+${earlier} earlier)`}`;
}

// Control characters (C0, DEL, C1) and the Unicode line and paragraph separators become spaces,
// whitespace runs collapse to one space, and the ends are trimmed: the text can no longer break a line.
export function singleLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim();
}

// Clipping counts code points, never UTF-16 units, so an astral character is never cut in half.
export function clipForBrief(text: string): string {
  const codePoints = [...text];
  if (codePoints.length <= MAX_BRIEF_QUERY_CODE_POINTS) return text;
  return `${codePoints.slice(0, MAX_BRIEF_QUERY_CODE_POINTS - 1).join("")}${CLIP_MARK}`;
}
