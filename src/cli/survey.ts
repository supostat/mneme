import { countStagedNotes } from "../staging";
import { resolveCurrentBranch } from "../workflow/run-branch";
import { inspectRuns } from "../workflow/run-survey";
import { renderSurveyLine } from "../workflow/run-survey-rendering";
import { runBriefCommand } from "./brief-command";
import { locateExistingCorpus } from "./cli-corpus";
import type { CliOptions } from "./cli-corpus";

// The SessionStart hook's entry into the read-only survey: the same binary that serves MCP answers
// `mneme survey --brief` from a shell with the tool's brief line — or with nothing. "Writes nothing"
// holds here more strongly than for the workflow_survey tool: this path never constructs an
// EventWriter, never calls resolveCorpus and never opens the index, so there is no session_start,
// no tool_error, no provisioned corpus and no stale mark by construction. Every outcome other than
// "an unfinished run on the current branch" is silence; the grammar and the fail-open exit code are
// runBriefCommand's.

export const SURVEY_COMMAND = "survey";
export const SURVEY_BRIEF_FLAG = "--brief";

export async function runSurveyCli(argv: string[], options: CliOptions): Promise<number> {
  return runBriefCommand(argv, options, { command: SURVEY_COMMAND, flag: SURVEY_BRIEF_FLAG, line: surveyBriefLine });
}

// null is every quiet outcome: a broken config, a corpus never provisioned here, an unanswerable
// branch, or no unfinished run on it. Only the last question needs the log; the others are answered
// without touching it.
async function surveyBriefLine(options: CliOptions): Promise<string | null> {
  const corpus = locateExistingCorpus(options);
  if (corpus === null) {
    return null;
  }
  const resolution = await resolveCurrentBranch(options.projectRoot);
  if (resolution.kind !== "branch") {
    return null;
  }
  const survey = await inspectRuns({ corpus, projectRoot: options.projectRoot }, resolution.name);
  if (survey.activeRun === null) {
    return null;
  }
  return renderSurveyLine(survey, countStagedNotes(corpus));
}
