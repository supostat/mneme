import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, ConfigError, DEFAULT_RECALL_BUDGET, defaultConfig, loadConfig } from "./config";
import { DEDUP_NOOP_THRESHOLD, DEDUP_SUPERSEDE_THRESHOLD } from "./dedup";
import { EMBEDDING_MODEL, OLLAMA_BASE_URL } from "./embeddings";

function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), "mneme-config-"));
}

function projectWithFile(content: string): string {
  const projectRoot = emptyProject();
  writeFileSync(join(projectRoot, CONFIG_FILE_NAME), content);
  return projectRoot;
}

// Every override test passes an EXPLICIT empty environment: the suite must not inherit MNEME_*
// variables from the shell that runs it.
const NO_ENV = {};

describe("default parity", () => {
  test("without a file or environment, the config IS the historical constants", () => {
    const config = loadConfig(emptyProject(), NO_ENV);

    expect(config).toEqual({
      embedder: { baseUrl: OLLAMA_BASE_URL, model: EMBEDDING_MODEL, format: "ollama" },
      dedup: { supersedeThreshold: DEDUP_SUPERSEDE_THRESHOLD, noopThreshold: DEDUP_NOOP_THRESHOLD },
      recall: { budget: DEFAULT_RECALL_BUDGET },
    });
    expect(config).toEqual(defaultConfig());
  });

  test("the historical constants are pinned: 127.0.0.1:11434, qwen3, 0.85/0.97, 2000", () => {
    expect(OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(EMBEDDING_MODEL).toBe("qwen3-embedding:0.6b");
    expect(DEDUP_SUPERSEDE_THRESHOLD).toBe(0.85);
    expect(DEDUP_NOOP_THRESHOLD).toBe(0.97);
    expect(DEFAULT_RECALL_BUDGET).toBe(2000);
  });
});

describe("file overrides", () => {
  test("a partial file overrides exactly what it states and leaves the rest at defaults", () => {
    const projectRoot = projectWithFile(
      JSON.stringify({ embedder: { base_url: "http://embed-host:8080" }, dedup: { supersede_threshold: 0.9 } }),
    );

    const config = loadConfig(projectRoot, NO_ENV);

    expect(config.embedder.baseUrl).toBe("http://embed-host:8080");
    expect(config.embedder.model).toBe(EMBEDDING_MODEL);
    expect(config.embedder.format).toBe("ollama");
    expect(config.dedup.supersedeThreshold).toBe(0.9);
    expect(config.dedup.noopThreshold).toBe(DEDUP_NOOP_THRESHOLD);
    expect(config.recall.budget).toBe(DEFAULT_RECALL_BUDGET);
  });

  test("a full file overrides every field", () => {
    const projectRoot = projectWithFile(
      JSON.stringify({
        embedder: { base_url: "http://lm-studio:1234", model: "nomic-embed-text", format: "openai" },
        dedup: { supersede_threshold: 0.8, noop_threshold: 0.95 },
        recall: { budget: 4000 },
      }),
    );

    expect(loadConfig(projectRoot, NO_ENV)).toEqual({
      embedder: { baseUrl: "http://lm-studio:1234", model: "nomic-embed-text", format: "openai" },
      dedup: { supersedeThreshold: 0.8, noopThreshold: 0.95 },
      recall: { budget: 4000 },
    });
  });
});

describe("environment overrides", () => {
  test("MNEME_* variables override both the defaults and the file", () => {
    const projectRoot = projectWithFile(JSON.stringify({ embedder: { base_url: "http://from-file:1" } }));

    const config = loadConfig(projectRoot, {
      MNEME_EMBEDDER_BASE_URL: "http://from-env:2",
      MNEME_EMBEDDER_MODEL: "env-model",
      MNEME_EMBEDDER_FORMAT: "openai",
      MNEME_DEDUP_SUPERSEDE_THRESHOLD: "0.7",
      MNEME_DEDUP_NOOP_THRESHOLD: "0.9",
      MNEME_RECALL_BUDGET: "1500",
    });

    expect(config).toEqual({
      embedder: { baseUrl: "http://from-env:2", model: "env-model", format: "openai" },
      dedup: { supersedeThreshold: 0.7, noopThreshold: 0.9 },
      recall: { budget: 1500 },
    });
  });

  test("a malformed numeric override is a named ConfigError, never a silent default", () => {
    expect(() => loadConfig(emptyProject(), { MNEME_DEDUP_SUPERSEDE_THRESHOLD: "high" })).toThrow(
      new ConfigError('MNEME_DEDUP_SUPERSEDE_THRESHOLD is "high"; it must be a number between 0 and 1'),
    );
    expect(() => loadConfig(emptyProject(), { MNEME_RECALL_BUDGET: "2.5" })).toThrow(
      new ConfigError('MNEME_RECALL_BUDGET is "2.5"; it must be a positive integer'),
    );
    expect(() => loadConfig(emptyProject(), { MNEME_EMBEDDER_FORMAT: "grpc" })).toThrow(
      new ConfigError('MNEME_EMBEDDER_FORMAT is "grpc"; it must be one of: ollama, openai'),
    );
  });
});

describe("fail-closed file validation", () => {
  test("broken JSON refuses the load with the file named", () => {
    const projectRoot = projectWithFile("{ not json");

    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(ConfigError);
    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(/is not valid JSON/);
    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(new RegExp(CONFIG_FILE_NAME));
  });

  test("an unknown key is a typo, not a silently ignored setting", () => {
    const projectRoot = projectWithFile(JSON.stringify({ embedder: { baseurl: "http://typo:1" } }));

    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(ConfigError);
    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(/embedder/);
  });

  test("an out-of-range threshold in the file is refused with its path", () => {
    const projectRoot = projectWithFile(JSON.stringify({ dedup: { noop_threshold: 1.5 } }));

    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(ConfigError);
    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(/dedup.noop_threshold/);
  });

  test("supersede above noop is refused wherever the values came from", () => {
    const projectRoot = projectWithFile(JSON.stringify({ dedup: { supersede_threshold: 0.98 } }));

    expect(() => loadConfig(projectRoot, NO_ENV)).toThrow(
      /supersede_threshold \(0.98\) must not exceed noop_threshold \(0.97\)/,
    );
  });
});
