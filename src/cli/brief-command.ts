import type { CliOptions } from "./cli-corpus";

// The one grammar every hook-facing subcommand obeys: exactly `<command> --brief`, one line on
// stdout or nothing, exit 0. "Writes nothing" is the subcommand's own construction — no EventWriter,
// no resolveCorpus, no index — and this wrapper adds the fail-open half: within the grammar the exit
// code is always 0, and an unforeseen fault (a corpus with its events/ gone, a permission problem)
// leaves one line on stderr for a person running the command by hand. Only a malformed argv — a
// human's typo, never a hook outcome — is refused with a usage line, the doctor's exit code.

export const USAGE_EXIT_CODE = 2;

// Each subcommand owns its name and flag as literal constants in its own module (the handoff guards
// read them off the source), and hands them in here.
export interface BriefCommand<Options extends CliOptions> {
  command: string;
  flag: string;
  // null is every quiet outcome: there is nothing to say, so the hook says nothing.
  line: (options: Options) => Promise<string | null>;
}

export async function runBriefCommand<Options extends CliOptions>(
  argv: string[],
  options: Options,
  briefCommand: BriefCommand<Options>,
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== briefCommand.command || argv[1] !== briefCommand.flag) {
    options.stderr(`unknown invocation "${argv.join(" ")}"\n${usageOf(briefCommand)}\n`);
    return USAGE_EXIT_CODE;
  }
  try {
    const line = await briefCommand.line(options);
    if (line !== null) {
      options.stdout(`${line}\n`);
    }
  } catch (error) {
    options.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 0;
}

export function usageOf(briefCommand: { command: string; flag: string }): string {
  return `usage: mneme ${briefCommand.command} ${briefCommand.flag}`;
}
