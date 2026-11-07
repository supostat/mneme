import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEDUP_NOOP_THRESHOLD, DEDUP_SUPERSEDE_THRESHOLD } from "./dedup";
import { EMBEDDER_FORMATS, EMBEDDING_MODEL, OLLAMA_BASE_URL } from "./embeddings";
import type { EmbedderFormat } from "./embeddings";
import { DEFAULT_RECALL_BUDGET } from "./fusion";
import { JUDGE_BASE_URL, JUDGE_MODEL } from "./judge";

// Project-level configuration: <projectRoot>/.mneme.json overridden by MNEME_* environment
// variables. Every default IS the historical constant, imported from its canonical module, so a
// project without a config file behaves byte-for-byte as before the file existed. Validation is
// fail-closed: a broken file or a malformed override is a named ConfigError, never a silent default.
//
// The judge (System One advisor on dedup) is configured in two halves on purpose: base_url and model
// may live in the file, the API key may live ONLY in the MNEME_JUDGE_API_KEY environment variable —
// the file sits in the project root and travels with its git. The judge is enabled exactly when the
// key is set; without it the engine behaves byte-for-byte as before the judge existed.

export class ConfigError extends Error {}

export const CONFIG_FILE_NAME = ".mneme.json";

// The corpus name becomes a directory under the corpus home, so its grammar is the security guard
// that keeps a configured value from escaping that home: no slashes and no dots means traversal is
// impossible by construction rather than by sanitizing a looser value.
export const CORPUS_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CORPUS_NAME_REQUIREMENT =
  "it must be a corpus slug: lowercase letters, digits, underscore or dash, " +
  "starting with a letter or digit, at most 64 characters";

export interface MnemeConfig {
  embedder: { baseUrl: string; model: string; format: EmbedderFormat };
  dedup: { supersedeThreshold: number; noopThreshold: number };
  recall: { budget: number };
  corpus: { name: string | undefined };
  judge: { baseUrl: string; model: string; apiKey: string | undefined };
}

export function defaultConfig(): MnemeConfig {
  return {
    embedder: { baseUrl: OLLAMA_BASE_URL, model: EMBEDDING_MODEL, format: "ollama" },
    dedup: { supersedeThreshold: DEDUP_SUPERSEDE_THRESHOLD, noopThreshold: DEDUP_NOOP_THRESHOLD },
    recall: { budget: DEFAULT_RECALL_BUDGET },
    corpus: { name: undefined },
    judge: { baseUrl: JUDGE_BASE_URL, model: JUDGE_MODEL, apiKey: undefined },
  };
}

const JUDGE_API_KEY_VARIABLE = "MNEME_JUDGE_API_KEY";

// Every section and field is optional (the file states only what it overrides), but unknown keys are
// rejected: a typo that would silently fall back to a default is exactly the fail-closed case.
const configFileSchema = z
  .object({
    embedder: z
      .object({
        base_url: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        format: z.enum(EMBEDDER_FORMATS).optional(),
      })
      .strict()
      .optional(),
    dedup: z
      .object({
        supersede_threshold: z.number().min(0).max(1).optional(),
        noop_threshold: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    recall: z
      .object({
        budget: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    corpus: z
      .object({
        name: z.string().regex(CORPUS_NAME_PATTERN, CORPUS_NAME_REQUIREMENT).optional(),
      })
      .strict()
      .optional(),
    // api_key is deliberately absent: the key never comes from the file (see refuseFileApiKey).
    judge: z
      .object({
        base_url: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigEnvironment = Record<string, string | undefined>;

export function loadConfig(projectRoot: string, environment: ConfigEnvironment = process.env): MnemeConfig {
  const config = defaultConfig();
  applyConfigFile(config, join(projectRoot, CONFIG_FILE_NAME));
  applyEnvironment(config, environment);
  if (config.dedup.supersedeThreshold > config.dedup.noopThreshold) {
    throw new ConfigError(
      `dedup supersede_threshold (${config.dedup.supersedeThreshold}) must not exceed ` +
        `noop_threshold (${config.dedup.noopThreshold})`,
    );
  }
  return config;
}

function applyConfigFile(config: MnemeConfig, configPath: string): void {
  if (!existsSync(configPath)) {
    return;
  }
  const json = parseJson(configPath, readFileSync(configPath, "utf8"));
  refuseFileApiKey(configPath, json);
  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : ` at "${issue.path.join(".")}"`;
    throw new ConfigError(`${configPath} is invalid${where}: ${issue?.message ?? "unknown issue"}`);
  }
  const file = parsed.data;
  config.embedder.baseUrl = file.embedder?.base_url ?? config.embedder.baseUrl;
  config.embedder.model = file.embedder?.model ?? config.embedder.model;
  config.embedder.format = file.embedder?.format ?? config.embedder.format;
  config.dedup.supersedeThreshold = file.dedup?.supersede_threshold ?? config.dedup.supersedeThreshold;
  config.dedup.noopThreshold = file.dedup?.noop_threshold ?? config.dedup.noopThreshold;
  config.recall.budget = file.recall?.budget ?? config.recall.budget;
  config.corpus.name = file.corpus?.name ?? config.corpus.name;
  config.judge.baseUrl = file.judge?.base_url ?? config.judge.baseUrl;
  config.judge.model = file.judge?.model ?? config.judge.model;
}

// The strict schema would refuse judge.api_key as an unknown key anyway; this check refuses it BY
// NAME, so the message says where the key belongs instead of calling it a typo.
function refuseFileApiKey(configPath: string, json: unknown): void {
  if (typeof json !== "object" || json === null) {
    return;
  }
  const judge = (json as { judge?: unknown }).judge;
  if (typeof judge === "object" && judge !== null && "api_key" in judge) {
    throw new ConfigError(
      `${configPath} must not carry judge.api_key: the file travels with the project's git, ` +
        `so the judge key is read only from the ${JUDGE_API_KEY_VARIABLE} environment variable`,
    );
  }
}

function parseJson(configPath: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${configPath} is not valid JSON: ${problem}`);
  }
}

function applyEnvironment(config: MnemeConfig, environment: ConfigEnvironment): void {
  config.embedder.baseUrl = environment["MNEME_EMBEDDER_BASE_URL"] ?? config.embedder.baseUrl;
  config.embedder.model = environment["MNEME_EMBEDDER_MODEL"] ?? config.embedder.model;
  config.embedder.format = embedderFormatFrom(environment) ?? config.embedder.format;
  config.dedup.supersedeThreshold =
    thresholdFrom(environment, "MNEME_DEDUP_SUPERSEDE_THRESHOLD") ?? config.dedup.supersedeThreshold;
  config.dedup.noopThreshold =
    thresholdFrom(environment, "MNEME_DEDUP_NOOP_THRESHOLD") ?? config.dedup.noopThreshold;
  config.recall.budget = budgetFrom(environment) ?? config.recall.budget;
  config.corpus.name = corpusNameFrom(environment) ?? config.corpus.name;
  config.judge.baseUrl = environment["MNEME_JUDGE_BASE_URL"] ?? config.judge.baseUrl;
  config.judge.model = environment["MNEME_JUDGE_MODEL"] ?? config.judge.model;
  config.judge.apiKey = judgeApiKeyFrom(environment);
}

// An empty value is the same as an unset one: `MNEME_JUDGE_API_KEY=` in a shell profile disables the
// judge instead of sending an empty bearer token.
function judgeApiKeyFrom(environment: ConfigEnvironment): string | undefined {
  const raw = environment[JUDGE_API_KEY_VARIABLE];
  return raw === undefined || raw === "" ? undefined : raw;
}

function corpusNameFrom(environment: ConfigEnvironment): string | undefined {
  const raw = environment["MNEME_CORPUS_NAME"];
  if (raw === undefined) {
    return undefined;
  }
  if (!CORPUS_NAME_PATTERN.test(raw)) {
    throw new ConfigError(`MNEME_CORPUS_NAME is "${raw}"; ${CORPUS_NAME_REQUIREMENT}`);
  }
  return raw;
}

function embedderFormatFrom(environment: ConfigEnvironment): EmbedderFormat | undefined {
  const raw = environment["MNEME_EMBEDDER_FORMAT"];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = z.enum(EMBEDDER_FORMATS).safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `MNEME_EMBEDDER_FORMAT is "${raw}"; it must be one of: ${EMBEDDER_FORMATS.join(", ")}`,
    );
  }
  return parsed.data;
}

function thresholdFrom(environment: ConfigEnvironment, name: string): number | undefined {
  const raw = environment[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigError(`${name} is "${raw}"; it must be a number between 0 and 1`);
  }
  return value;
}

function budgetFrom(environment: ConfigEnvironment): number | undefined {
  const raw = environment["MNEME_RECALL_BUDGET"];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`MNEME_RECALL_BUDGET is "${raw}"; it must be a positive integer`);
  }
  return value;
}
