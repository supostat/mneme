import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorForProject } from "../scripts/doctor";
import { CONFIG_FILE_NAME, ConfigError } from "../src/config";
import { EMBEDDING_DIMENSION } from "../src/embeddings";
import type { EmbeddingsHttpResponse } from "../src/embeddings";
import type { DoctorReport } from "../src/doctor";

// The CLI wiring under test: doctorForProject must build its embedder from the project's
// .mneme.json (the server's own endpoint, model, and wire format), refuse a broken config with the
// named ConfigError, and keep the historical default behavior when no config file exists. The
// corpus itself is deliberately absent — runGuarded isolates those components; only the embeddings
// probe and the config path are this suite's subject.

function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), "mneme-doctor-cli-proj-"));
}

function isolatedCorpusHome(): string {
  return mkdtempSync(join(tmpdir(), "mneme-doctor-cli-home-"));
}

function validRow(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => Math.sin(index) * 0.01);
}

function okResponse(payload: unknown): EmbeddingsHttpResponse {
  return { ok: true, json: async () => payload };
}

function embeddingsComponent(report: DoctorReport) {
  const component = report.components.find((candidate) => candidate.name === "embeddings");
  if (component === undefined) throw new Error("report carries no embeddings component");
  return component;
}

describe("doctorForProject config wiring", () => {
  test("a configured openai endpoint is probed as openai and reports ok", async () => {
    const projectRoot = emptyProject();
    writeFileSync(
      join(projectRoot, CONFIG_FILE_NAME),
      JSON.stringify({ embedder: { base_url: "http://stub.invalid:1234", model: "stub-embed", format: "openai" } }),
    );
    const urls: string[] = [];

    const report = await doctorForProject(projectRoot, {
      corpusHome: isolatedCorpusHome(),
      environment: {},
      fetchImplementation: async (url, init) => {
        urls.push(url);
        const body = JSON.parse(init.body) as { model: string };
        expect(body.model).toBe("stub-embed");
        return okResponse({ data: [{ embedding: validRow() }] });
      },
    });

    expect(urls).toEqual(["http://stub.invalid:1234/v1/embeddings"]);
    expect(embeddingsComponent(report).status).toBe("ok");
  });

  test("a broken .mneme.json refuses the doctor with the named ConfigError, before any probe", async () => {
    const projectRoot = emptyProject();
    writeFileSync(join(projectRoot, CONFIG_FILE_NAME), "{ not json");
    let probed = false;

    const attempt = doctorForProject(projectRoot, {
      corpusHome: isolatedCorpusHome(),
      environment: {},
      fetchImplementation: async () => {
        probed = true;
        return okResponse({ embeddings: [validRow()] });
      },
    });

    expect(attempt).rejects.toThrow(ConfigError);
    expect(attempt).rejects.toThrow(new RegExp(CONFIG_FILE_NAME));
    await attempt.catch(() => {});
    expect(probed).toBe(false);
  });

  test("without a config file the probe hits the historical default Ollama endpoint", async () => {
    const projectRoot = emptyProject();
    const urls: string[] = [];

    const report = await doctorForProject(projectRoot, {
      corpusHome: isolatedCorpusHome(),
      environment: {},
      fetchImplementation: async (url) => {
        urls.push(url);
        return okResponse({ embeddings: [validRow()] });
      },
    });

    expect(urls).toEqual(["http://127.0.0.1:11434/api/embed"]);
    expect(embeddingsComponent(report).status).toBe("ok");
  });
});
