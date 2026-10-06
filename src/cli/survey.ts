import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "../config";
import type { ConfigEnvironment, MnemeConfig } from "../config";
import { corpusDirFor, corpusPaths } from "../corpus";
import type { Corpus } from "../corpus";
import { countStagedNotes } from "../staging";
import { resolveCurrentBranch } from "../workflow/run-branch";
import { inspectRuns } from "../workflow/run-survey";
import { renderSurveyLine } from "../workflow/run-survey-rendering";

// The SessionStart hook's entry into the read-only survey: the same binary that serves MCP answers
// `mneme survey --brief` from a shell with the tool's brief line — or with nothing. "Writes nothing"
// holds here more strongly than for the workflow_survey tool: this path never constructs an
// EventWriter, never calls resolveCorpus and never opens the index, so there is no session_start,
// no tool_error, no provisioned corpus and no stale mark by construction. The hook is fail-open:
// within the grammar the exit code is always 0, and every outcome other than "an unfinished run on
// the current branch" is silence. Only a malformed argv — a human's typo, never a hook outcome — is
// refused with a usage line, the doctor's exit code.

export const SURVEY_COMMAND = "survey";
export const SURVEY_BRIEF_FLAG = "--brief";
const USAGE = `usage: mneme ${SURVEY_COMMAND} ${SURVEY_BRIEF_FLAG}`;
const USAGE_EXIT_CODE = 2;

export interface SurveyCliOptions {
  projectRoot: string;
  corpusHome?: string;
  environment?: ConfigEnvironment;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runSurveyCli(argv: string[], options: SurveyCliOptions): Promise<number> {
  if (!isSurveyBriefInvocation(argv)) {
    options.stderr(`unknown invocation "${argv.join(" ")}"\n${USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  try {
    const line = await surveyBriefLine(options);
    if (line !== null) {
      options.stdout(`${line}\n`);
    }
  } catch (error) {
    // An unforeseen fault (a corpus with its events/ gone, a permission problem) stays fail-open
    // for the hook but leaves one line for a person running the command by hand.
    options.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 0;
}

function isSurveyBriefInvocation(argv: string[]): boolean {
  return argv.length === 2 && argv[0] === SURVEY_COMMAND && argv[1] === SURVEY_BRIEF_FLAG;
}

// null is every quiet outcome: a broken config, a corpus never provisioned here, an unanswerable
// branch, or no unfinished run on it. Only the last question needs the log; the others are answered
// without touching it.
async function surveyBriefLine(options: SurveyCliOptions): Promise<string | null> {
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

// The corpus is LOCATED, never created: the pure derivation the doctor uses (corpusDirFor honours
// the configured corpus name, so a shared corpus is found where the server reads it), then an
// existence check. A project that never ran the server here has no corpus — silence, not provisioning.
function locateExistingCorpus(options: SurveyCliOptions): Corpus | null {
  const config = loadConfigQuietly(options);
  if (config === null) {
    return null;
  }
  const location = corpusDirFor(options.projectRoot, options.corpusHome, config.corpus.name);
  if (!existsSync(location.corpusDir)) {
    return null;
  }
  return { canonicalRoot: location.canonicalRoot, ...corpusPaths(location.corpusDir) };
}

// The server refuses a broken .mneme.json loudly (fail-closed at construction); the hook cannot
// afford to, so a named ConfigError is a quiet outcome here and every other fault still propagates.
function loadConfigQuietly(options: SurveyCliOptions): MnemeConfig | null {
  try {
    return loadConfig(options.projectRoot, options.environment);
  } catch (error) {
    if (error instanceof ConfigError) {
      return null;
    }
    throw error;
  }
}
