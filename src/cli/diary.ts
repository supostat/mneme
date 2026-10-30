import { branchTerminalOf } from "../diary/diary-branch";
import { renderDiaryLine } from "../diary/diary-rendering";
import type { BriefGaps } from "../diary/diary-rendering";
import { liveSessionIds, sessionFacts } from "../diary/diary-session-facts";
import type { ProcessAliveCheck } from "../diary/diary-session-facts";
import { readEvents } from "../events";
import type { StoredEvent } from "../events";
import { runBriefCommand } from "./brief-command";
import { locateExistingCorpus } from "./cli-corpus";
import type { CliOptions } from "./cli-corpus";

// The UserPromptSubmit hook's entry into the diary: `mneme diary --brief` prints the diary_facts
// brief line — the current branch's last finished run while it has no diary entry, and the memory
// gaps still open since the session's last note — or nothing. It writes nothing exactly as the survey
// CLI does: no EventWriter, no resolveCorpus, no index; the log is read once.
//
// A shell does not know which Claude session it serves, so the session is the one LIVE server session
// in the log: a session_start whose pid still runs and that has no session_end. A session killed
// without its end is dead by its pid; two live sessions on one corpus cannot be told apart, and the
// gap segment names that instead of picking one.

export const DIARY_COMMAND = "diary";
export const DIARY_BRIEF_FLAG = "--brief";

export type DiaryCliOptions = CliOptions & { isProcessAlive: ProcessAliveCheck };

export async function runDiaryCli(argv: string[], options: DiaryCliOptions): Promise<number> {
  return runBriefCommand(argv, options, { command: DIARY_COMMAND, flag: DIARY_BRIEF_FLAG, line: diaryBriefLine });
}

// null when the config is broken, the corpus was never provisioned here, or neither segment has
// anything to say. Off a branch only the run segment drops out; the gaps still speak.
async function diaryBriefLine(options: DiaryCliOptions): Promise<string | null> {
  const corpus = locateExistingCorpus(options);
  if (corpus === null) {
    return null;
  }
  const events = readEvents(corpus.eventsDir);
  const terminal = await branchTerminalOf(options.projectRoot, events);
  const lastTerminal = terminal.kind === "branch" ? terminal.lastTerminal : null;
  return renderDiaryLine(lastTerminal, briefGapsOf(events, options.isProcessAlive));
}

function briefGapsOf(events: StoredEvent[], isProcessAlive: ProcessAliveCheck): BriefGaps {
  const live = liveSessionIds(events, isProcessAlive);
  if (live.length === 0) return { kind: "no-live-session" };
  if (live.length > 1) return { kind: "shared", liveSessions: live.length };
  return { kind: "session", facts: sessionFacts(events, live[0]!) };
}
