import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEDUP_NOOP_THRESHOLD, DEDUP_SUPERSEDE_THRESHOLD } from "./dedup";
import { EMBEDDING_MODEL, OLLAMA_BASE_URL } from "./embeddings";

// Project-level configuration: <projectRoot>/.mneme.json overridden by MNEME_* environment
// variables. Every default IS the historical constant, imported from its canonical module, so a
// project without a config file behaves byte-for-byte as before the file existed. Validation is
// fail-closed: a broken file or a malformed override is a named ConfigError, never a silent default.

export class ConfigError extends Error {}

export const CONFIG_FILE_NAME = ".mneme.json";
export const DEFAULT_RECALL_BUDGET = 2000;

export const EMBEDDER_FORMATS = ["ollama", "openai"] as const;
export type EmbedderFormat = (typeof EMBEDDER_FORMATS)[number];

export interface MnemeConfig {
  embedder: { baseUrl: string; model: string; format: EmbedderFormat };
  dedup: { supersedeThreshold: number; noopThreshold: number };
  recall: { budget: number };
}

export function defaultConfig(): MnemeConfig {
  return {
    embedder: { baseUrl: OLLAMA_BASE_URL, model: EMBEDDING_MODEL, format: "ollama" },
    dedup: { supersedeThreshold: DEDUP_SUPERSEDE_THRESHOLD, noopThreshold: DEDUP_NOOP_THRESHOLD },
    recall: { budget: DEFAULT_RECALL_BUDGET },
  };
}

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
  const parsed = configFileSchema.safeParse(parseJson(configPath, readFileSync(configPath, "utf8")));
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
