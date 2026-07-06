import { test, expect, describe } from "bun:test";
import {
  OllamaEmbeddingsClient,
  EMBEDDING_DIMENSION,
  EMBED_ATTEMPTS,
  EMBED_TIMEOUT_MS,
  RECALL_EMBED_ATTEMPTS,
  RECALL_EMBED_TIMEOUT_MS,
} from "./embeddings";
import type { EmbeddingsHttpRequest, EmbeddingsHttpResponse, FetchImplementation } from "./embeddings";

const BASE_URL = "http://stub.invalid:11434";

function validRow(seed = 0): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => Math.sin(seed + index) * 0.01);
}

function okResponse(payload: unknown): EmbeddingsHttpResponse {
  return { ok: true, json: async () => payload };
}

interface CallLog {
  count: number;
  lastRequest: EmbeddingsHttpRequest | undefined;
}

function recordingFetch(payload: unknown, log: CallLog): FetchImplementation {
  return async (_url, init) => {
    log.count++;
    log.lastRequest = init;
    return okResponse(payload);
  };
}

describe("OllamaEmbeddingsClient happy path", () => {
  test("embeds each input into a finite 1024-dimension vector", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };
    const client = new OllamaEmbeddingsClient(
      BASE_URL,
      recordingFetch({ embeddings: [validRow(1), validRow(2)] }, log),
    );

    const result = await client.embed(["alpha", "beta"]);

    expect(result.available).toBe(true);
    expect(result.embeddings.length).toBe(2);
    expect(result.embeddings[0]).toBeInstanceOf(Float32Array);
    expect(result.embeddings[0]!.length).toBe(EMBEDDING_DIMENSION);
    expect(result.embeddings[1]!.length).toBe(EMBEDDING_DIMENSION);
    expect(log.count).toBe(1);
  });

  test("sends the pinned model and the inputs in the request body", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };
    const client = new OllamaEmbeddingsClient(BASE_URL, recordingFetch({ embeddings: [validRow()] }, log));

    await client.embed(["only"]);

    const body = JSON.parse(log.lastRequest!.body);
    expect(body.model).toBe("qwen3-embedding:0.6b");
    expect(body.input).toEqual(["only"]);
  });
});

describe("OllamaEmbeddingsClient empty input", () => {
  test("returns an available empty result without issuing a request", async () => {
    const log: CallLog = { count: 0, lastRequest: undefined };
    const client = new OllamaEmbeddingsClient(BASE_URL, recordingFetch({ embeddings: [] }, log));

    const result = await client.embed([]);

    expect(result).toEqual({ available: true, embeddings: [] });
    expect(log.count).toBe(0);
  });
});

describe("OllamaEmbeddingsClient typed degradation", () => {
  test("a refused connection degrades without throwing", async () => {
    const client = new OllamaEmbeddingsClient(BASE_URL, async () => {
      throw new TypeError("connection refused");
    });

    const result = await client.embed(["alpha"]);

    expect(result).toEqual({ available: false, embeddings: [] });
  });

  test("a non-ok response degrades", async () => {
    const client = new OllamaEmbeddingsClient(BASE_URL, async () => ({
      ok: false,
      json: async () => ({ embeddings: [validRow()] }),
    }));

    const result = await client.embed(["alpha"]);

    expect(result).toEqual({ available: false, embeddings: [] });
  });

  test("a hanging server degrades within the timeout budget", async () => {
    const client = new OllamaEmbeddingsClient(BASE_URL, (_url, init) => {
      return new Promise<EmbeddingsHttpResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const start = Date.now();
    const result = await client.embed(["alpha"], { timeoutMs: 60, attempts: 1 });
    const elapsed = Date.now() - start;

    expect(result).toEqual({ available: false, embeddings: [] });
    expect(elapsed).toBeLessThan(1000);
  });

  test("a wrong-dimension row degrades", async () => {
    const client = new OllamaEmbeddingsClient(BASE_URL, async () =>
      okResponse({ embeddings: [validRow().slice(0, EMBEDDING_DIMENSION - 1)] }),
    );

    const result = await client.embed(["alpha"]);

    expect(result).toEqual({ available: false, embeddings: [] });
  });

  test("a non-finite float degrades", async () => {
    const row = validRow();
    row[0] = Number.POSITIVE_INFINITY;
    const client = new OllamaEmbeddingsClient(BASE_URL, async () => okResponse({ embeddings: [row] }));

    const result = await client.embed(["alpha"]);

    expect(result).toEqual({ available: false, embeddings: [] });
  });

  test("a row-count mismatch degrades", async () => {
    const client = new OllamaEmbeddingsClient(BASE_URL, async () =>
      okResponse({ embeddings: [validRow()] }),
    );

    const result = await client.embed(["alpha", "beta"]);

    expect(result).toEqual({ available: false, embeddings: [] });
  });
});

describe("OllamaEmbeddingsClient per-call retry and timeout overrides", () => {
  function slowThenFastFetch(counter: { calls: number }): FetchImplementation {
    return (_url, init) => {
      counter.calls++;
      if (counter.calls === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(okResponse({ embeddings: [validRow()] }));
    };
  }

  test("a single-attempt call fails fast on the first hang", async () => {
    const counter = { calls: 0 };
    const client = new OllamaEmbeddingsClient(BASE_URL, slowThenFastFetch(counter));

    const result = await client.embed(["alpha"], { timeoutMs: 50, attempts: 1 });

    expect(result.available).toBe(false);
    expect(counter.calls).toBe(1);
  });

  test("a two-attempt call retries past the first hang and succeeds", async () => {
    const counter = { calls: 0 };
    const client = new OllamaEmbeddingsClient(BASE_URL, slowThenFastFetch(counter));

    const result = await client.embed(["alpha"], { timeoutMs: 50, attempts: 2 });

    expect(result.available).toBe(true);
    expect(counter.calls).toBe(2);
  });

  test("recall and rebuild constants are pinned distinctly", () => {
    expect(EMBED_TIMEOUT_MS).toBe(5000);
    expect(EMBED_ATTEMPTS).toBe(2);
    expect(RECALL_EMBED_TIMEOUT_MS).toBe(2000);
    expect(RECALL_EMBED_ATTEMPTS).toBe(1);
  });
});
