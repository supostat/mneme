import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readEvents } from "../events";
import { textResult } from "../mcp-rendering";
import type { StagingDeps } from "../staging";
import { branchTerminalOf } from "./diary-branch";
import { BRIEF_WITH_RUN_ID_TEXT, DIARY_BRIEF_NOTHING, renderDiaryLine, renderRunAnswer, renderSessionFacts } from "./diary-rendering";
import { runFacts } from "./diary-run-facts";
import { sessionFacts } from "./diary-session-facts";

// The read-only diary_facts tool. Its deps carry no EventWriter, so "writes nothing" is a property
// of the types: the corpus is only read (its event log) and git is only asked for the branch. Every
// answer that is not facts — a malformed run_id, an unknown or unreadable run, a run still going,
// brief combined with run_id — is plain text, never a throw: the server's dispatch logs a
// tool_error on a throw, and this tool must leave the log exactly as it found it.

export const DIARY_FACTS_DESCRIPTION =
  "Read the facts a diary retro stands on WITHOUT side effects: it reads the event log and git and " +
  "writes NOTHING — no event, no file, no stale mark. With run_id: the facts of one FINISHED run of " +
  "any branch — branch, status, start and end, iterations; per phase the attempts, every gate " +
  "failure with its criterion and reason, the harvest by note kind, the used-notes count and the " +
  "bundle's memory gap; the escalation; the curation of the notes the run staged (staged / accepted " +
  "/ rejected / superseded); and whether the run already has a diary entry (a note tagged diary " +
  "and run:<run_id>). Without run_id: THIS server session — its manual recalls, its memory gaps in " +
  "time order with the ones still open since the session's last note, its note count — and the " +
  "current branch's last finished run with whether it has a diary entry. Pass brief: true " +
  "(without run_id) for the ONE-LINE form a prompt hook prints. Facts the log did not record " +
  "before schema v22 read as not instrumented.";

export const DIARY_FACTS_INPUT = {
  run_id: z.string().optional(),
  brief: z.boolean().optional(),
};

export interface DiaryFactsArgs {
  run_id?: string;
  brief?: boolean;
}

export type DiaryToolDeps = Pick<StagingDeps, "corpus" | "projectRoot"> & { sessionId: string };

export async function diaryFactsTool(deps: DiaryToolDeps, args: DiaryFactsArgs): Promise<CallToolResult> {
  if (args.brief === true && args.run_id !== undefined) return textResult(BRIEF_WITH_RUN_ID_TEXT);
  const events = readEvents(deps.corpus.eventsDir);
  if (args.run_id !== undefined) return textResult(renderRunAnswer(runFacts(events, args.run_id)));
  const facts = sessionFacts(events, deps.sessionId);
  const terminal = await branchTerminalOf(deps.projectRoot, events);
  if (args.brief !== true) return textResult(renderSessionFacts(facts, terminal));
  const lastTerminal = terminal.kind === "branch" ? terminal.lastTerminal : null;
  return textResult(renderDiaryLine(lastTerminal, { kind: "session", facts }) ?? DIARY_BRIEF_NOTHING);
}
