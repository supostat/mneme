import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "../config";
import type { ConfigEnvironment, MnemeConfig } from "../config";
import { corpusDirFor, corpusPaths } from "../corpus";
import type { Corpus } from "../corpus";

// What every hook-facing subcommand of the binary shares: where it runs, where corpora live, the
// environment that may rename the corpus, and the two streams it may write to — never the corpus.

export interface CliOptions {
  projectRoot: string;
  corpusHome?: string;
  environment?: ConfigEnvironment;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// The corpus is LOCATED, never created: the pure derivation the doctor uses (corpusDirFor honours
// the configured corpus name, so a shared corpus is found where the server reads it), then an
// existence check. A project that never ran the server here has no corpus — silence, not
// provisioning. null is every quiet outcome: a broken config or a corpus that does not exist.
export function locateExistingCorpus(options: CliOptions): Corpus | null {
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

// The server refuses a broken .mneme.json loudly (fail-closed at construction); a hook cannot
// afford to, so a named ConfigError is a quiet outcome here and every other fault still propagates.
function loadConfigQuietly(options: CliOptions): MnemeConfig | null {
  try {
    return loadConfig(options.projectRoot, options.environment);
  } catch (error) {
    if (error instanceof ConfigError) {
      return null;
    }
    throw error;
  }
}
