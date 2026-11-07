import { describe, expect, test } from "bun:test";
import {
  HttpJudgeClient,
  JUDGE_ATTEMPTS,
  JUDGE_BASE_URL,
  JUDGE_ENDPOINT_PATH,
  JUDGE_MODEL,
  JUDGE_TIMEOUT_MS,
} from "./judge";
import type { JudgeAnswers, JudgeQuestions } from "./judge";
import type { EmbeddingsHttpRequest, EmbeddingsHttpResponse, FetchImplementation } from "./embeddings";

// Every case drives the REAL HttpJudgeClient; only fetch, the network boundary, is a stand-in. The
// key is a recognizable token so a leak into any returned value would be found by a substring search.

const BASE_URL = "https://judge.invalid";
const API_KEY = "apikey-LEAK-CANARY-0123456789";
const MODEL = "jev-test";

const RELATION_OPTIONS = ["duplicate", "supersedes", "contradicts", "complements", "unrelated"];

const QUESTIONS: JudgeQuestions = {
  relation: {
    type: "choice",
    instructions: "How does note A relate to note B?",
    criteria: {
      duplicate: "A restates what B already says",
      supersedes: "A updates or corrects B",
      contradicts: "A and B disagree",
      complements: "A adds new facts about the same subject",
      unrelated: "A and B are about different subjects",
    },
  },
};

const STATE = { context: "two notes", note_a: { body: "A" }, note_b: { body: "B" } };

function validAnswers(): JudgeAnswers {
  return {
    relation: {
      type: "choice",
      choice: "supersedes",
      probabilities: { duplicate: 0.01, supersedes: 0.9, contradicts: 0.05, complements: 0.04, unrelated: 0 },
      confidence: 0.88,
    },
  };
}

function okResponse(payload: unknown): EmbeddingsHttpResponse {
  return { ok: true, json: async () => payload };
}

interface CallLog {
  count: number;
  lastUrl: string | undefined;
  lastRequest: EmbeddingsHttpRequest | undefined;
}

function recordingFetch(response: EmbeddingsHttpResponse, log: CallLog): FetchImplementation {
  return async (url, init) => {
    log.count++;
    log.lastUrl = url;
    log.lastRequest = init;
    return response;
  };
}

function client(fetchImplementation: FetchImplementation): HttpJudgeClient {
  return new HttpJudgeClient(BASE_URL, fetchImplementation, MODEL, API_KEY);
}

function emptyLog(): CallLog {
  return { count: 0, lastUrl: undefined, lastRequest: undefined };
}

describe("HttpJudgeClient speaks the System One contract", () => {
  test("posts {model, state, questions} to <baseUrl>/v1/systemone under the bearer key", async () => {
    const log = emptyLog();

    await client(recordingFetch(okResponse({ model: MODEL, answers: validAnswers() }), log)).judge(STATE, QUESTIONS);

    expect(log.lastUrl).toBe(`${BASE_URL}${JUDGE_ENDPOINT_PATH}`);
    expect(log.lastRequest!.method).toBe("POST");
    expect(log.lastRequest!.headers["content-type"]).toBe("application/json");
    expect(log.lastRequest!.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(log.lastRequest!.body)).toEqual({ model: MODEL, state: STATE, questions: QUESTIONS });
  });

  test("a 2xx answer of the right shape is available with the answers as sent", async () => {
    const result = await client(recordingFetch(okResponse({ model: MODEL, answers: validAnswers(), usage: { input_tokens: 10, output_tokens: 2 } }), emptyLog())).judge(STATE, QUESTIONS);

    expect(result).toEqual({ available: true, answers: validAnswers() });
  });

  test("a noul question is answered with a probability", async () => {
    const questions: JudgeQuestions = { probe: { type: "noul", instructions: "The state names a probe." } };

    const result = await client(recordingFetch(okResponse({ answers: { probe: { type: "noul", noul: 0.68 } } }), emptyLog())).judge("probe", questions);

    expect(result).toEqual({ available: true, answers: { probe: { type: "noul", noul: 0.68 } } });
  });

  test("the model name travels with the client and the constants are pinned", () => {
    expect(client(async () => okResponse({})).model).toBe(MODEL);
    expect(JUDGE_BASE_URL).toBe("https://api.typesafe.ai");
    expect(JUDGE_MODEL).toBe("jev-latest");
    expect(JUDGE_ENDPOINT_PATH).toBe("/v1/systemone");
    expect(JUDGE_TIMEOUT_MS).toBe(3000);
    expect(JUDGE_ATTEMPTS).toBe(1);
  });
});

describe("HttpJudgeClient degrades on every class of failure", () => {
  test("a 401 is unavailable", async () => {
    const result = await client(async () => ({ ok: false, json: async () => ({ error: "unauthorized" }) })).judge(STATE, QUESTIONS);

    expect(result).toEqual({ available: false });
  });

  test("a 500 is unavailable", async () => {
    const result = await client(async () => ({ ok: false, json: async () => ({ error: "boom" }) })).judge(STATE, QUESTIONS);

    expect(result).toEqual({ available: false });
  });

  test("a fetch that throws (the network) is unavailable", async () => {
    const result = await client(async () => {
      throw new TypeError("connection refused");
    }).judge(STATE, QUESTIONS);

    expect(result).toEqual({ available: false });
  });

  test("a fetch that never answers is unavailable once the timeout fires", async () => {
    const hanging: FetchImplementation = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    const started = Date.now();

    const result = await client(hanging).judge(STATE, QUESTIONS, { timeoutMs: 50 });

    expect(result).toEqual({ available: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  const malformed: Array<[string, unknown]> = [
    ["no answer for the question key", { answers: {} }],
    ["an answer for a key that was never asked", { answers: { ...validAnswers(), extra: { type: "noul", noul: 0.5 } } }],
    ["a choice outside the options", { answers: { relation: { ...(validAnswers().relation as object), choice: "maybe" } } }],
    [
      "probabilities carrying an option that was never offered",
      {
        answers: {
          relation: {
            ...(validAnswers().relation as object),
            probabilities: { duplicate: 0, supersedes: 0.9, contradicts: 0, complements: 0, unrelated: 0, maybe: 0.1 },
          },
        },
      },
    ],
    [
      "probabilities missing an option",
      { answers: { relation: { ...(validAnswers().relation as object), probabilities: { supersedes: 1 } } } },
    ],
    [
      "a probability above one",
      {
        answers: {
          relation: {
            ...(validAnswers().relation as object),
            probabilities: { duplicate: 0, supersedes: 1.2, contradicts: 0, complements: 0, unrelated: 0 },
          },
        },
      },
    ],
    ["a negative confidence", { answers: { relation: { ...(validAnswers().relation as object), confidence: -0.1 } } }],
    ["a noul outside [0, 1] where a choice was asked", { answers: { relation: { type: "noul", noul: 1.5 } } }],
    ["a body that is not an object", "not json at all"],
  ];

  for (const [name, payload] of malformed) {
    test(`a malformed answer — ${name} — is unavailable`, async () => {
      const result = await client(recordingFetch(okResponse(payload), emptyLog())).judge(STATE, QUESTIONS);

      expect(result).toEqual({ available: false });
    });
  }

  test("a response whose body is not JSON is unavailable", async () => {
    const result = await client(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })).judge(STATE, QUESTIONS);

    expect(result).toEqual({ available: false });
  });
});

describe("HttpJudgeClient keeps the key and the attempt budget", () => {
  test("the key never appears in a result, available or not", async () => {
    const available = await client(recordingFetch(okResponse({ answers: validAnswers() }), emptyLog())).judge(STATE, QUESTIONS);
    const unavailable = await client(async () => {
      throw new Error(`refused for ${API_KEY}`);
    }).judge(STATE, QUESTIONS);

    expect(JSON.stringify(available)).not.toContain(API_KEY);
    expect(JSON.stringify(unavailable)).not.toContain(API_KEY);
  });

  test("a failure is tried exactly once by default", async () => {
    const log = emptyLog();

    await client(recordingFetch({ ok: false, json: async () => ({}) }, log)).judge(STATE, QUESTIONS);

    expect(log.count).toBe(JUDGE_ATTEMPTS);
    expect(log.count).toBe(1);
  });

  test("an explicit attempts option retries a failure that many times", async () => {
    const log = emptyLog();

    await client(recordingFetch({ ok: false, json: async () => ({}) }, log)).judge(STATE, QUESTIONS, { attempts: 3 });

    expect(log.count).toBe(3);
  });
});
