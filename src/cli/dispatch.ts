import { USAGE_EXIT_CODE, usageOf } from "./brief-command";
import { DIARY_BRIEF_FLAG, DIARY_COMMAND, runDiaryCli } from "./diary";
import type { DiaryCliOptions } from "./diary";
import { runSurveyCli, SURVEY_BRIEF_FLAG, SURVEY_COMMAND } from "./survey";

// The binary's shell entry, reached before main() whenever argv is not empty: main() provisions the
// corpus and logs a session before any tool call, so a subcommand that must write nothing branches
// off here. Each subcommand checks its own full grammar; an unknown first word is refused with the
// usage of every subcommand.

const CLI_USAGE = [
  usageOf({ command: SURVEY_COMMAND, flag: SURVEY_BRIEF_FLAG }),
  usageOf({ command: DIARY_COMMAND, flag: DIARY_BRIEF_FLAG }),
].join("\n");

export async function runCli(argv: string[], options: DiaryCliOptions): Promise<number> {
  if (argv[0] === SURVEY_COMMAND) return runSurveyCli(argv, options);
  if (argv[0] === DIARY_COMMAND) return runDiaryCli(argv, options);
  options.stderr(`unknown invocation "${argv.join(" ")}"\n${CLI_USAGE}\n`);
  return USAGE_EXIT_CODE;
}
