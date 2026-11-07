import { z } from "zod";
import type { FetchImplementation } from "./embeddings";

// The judge is a System One model (TypeSafe's Jev): it takes a state and typed questions and answers
// with probabilities, never with generated text. The wire contract is POST <baseUrl>/v1/systemone
// with { model, state, questions } under a bearer key; the answer is { model, answers, usage } where
// each answer mirrors its question's type. The client is an ADVISOR's client: every failure — the
// endpoint unreachable, a non-2xx status, a timeout, a malformed answer — collapses into
// { available: false } so a caller degrades instead of throwing, exactly as the embedder does. The
// key travels only in the request header; it never appears in a result, an error, or a log line.

export const JUDGE_BASE_URL = "https://api.typesafe.ai";
export const JUDGE_MODEL = "jev-latest";
export const JUDGE_ENDPOINT_PATH = "/v1/systemone";
// One short attempt: the judge sits on the remember path, which must not wait for retries.
export const JUDGE_TIMEOUT_MS = 3000;
export const JUDGE_ATTEMPTS = 1;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  // option -> the description of when it applies; the keys are the only answers the judge may give.
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export type JudgeQuestion = ChoiceQuestion | NoulQuestion;
export type JudgeQuestions = Record<string, JudgeQuestion>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type JudgeAnswer = ChoiceAnswer | NoulAnswer;
export type JudgeAnswers = Record<string, JudgeAnswer>;

export type JudgeResult = { available: true; answers: JudgeAnswers } | { available: false };

export interface JudgeOptions {
  timeoutMs?: number;
  attempts?: number;
}

// The model name travels with the client so the verdict that lands in the sidecar and the event log
// names the model that produced it — probabilities of one model are not comparable to another's.
export interface JudgeClient {
  readonly model: string;
  judge(state: unknown, questions: JudgeQuestions, options?: JudgeOptions): Promise<JudgeResult>;
}

export class HttpJudgeClient implements JudgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: FetchImplementation,
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async judge(state: unknown, questions: JudgeQuestions, options: JudgeOptions = {}): Promise<JudgeResult> {
    const timeoutMs = options.timeoutMs ?? JUDGE_TIMEOUT_MS;
    const attempts = options.attempts ?? JUDGE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const answers = await attemptJudge(this.fetchImplementation, this.baseUrl, this.model, this.apiKey, state, questions, timeoutMs);
      if (answers !== undefined) {
        return { available: true, answers };
      }
    }
    return { available: false };
  }
}

async function attemptJudge(
  fetchImplementation: FetchImplementation,
  baseUrl: string,
  model: string,
  apiKey: string,
  state: unknown,
  questions: JudgeQuestions,
  timeoutMs: number,
): Promise<JudgeAnswers | undefined> {
  try {
    const response = await fetchImplementation(`${baseUrl}${JUDGE_ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return undefined;
    }
    const parsed = responseSchema(questions).safeParse(await response.json());
    return parsed.success ? parsed.data.answers : undefined;
  } catch {
    return undefined;
  }
}

const probability = z.number().min(0).max(1);

// The answer schema is derived from the questions: every question key must be answered, no other
// key may appear, a choice must be one of the question's options with a probability for each option
// and no other, and every number must be a probability. Anything else is a malformed answer, which
// degrades exactly like an unreachable endpoint.
function responseSchema(questions: JudgeQuestions) {
  const answerShape: Record<string, z.ZodType<JudgeAnswer>> = {};
  for (const [key, question] of Object.entries(questions)) {
    answerShape[key] = question.type === "choice" ? choiceAnswerSchema(Object.keys(question.criteria)) : noulAnswerSchema;
  }
  return z.object({ answers: z.object(answerShape).strict() });
}

const noulAnswerSchema = z.object({ type: z.literal("noul"), noul: probability });

function choiceAnswerSchema(options: string[]) {
  const option = z.enum(options);
  return z.object({
    type: z.literal("choice"),
    choice: option,
    probabilities: z.record(option, probability),
    confidence: probability,
  });
}
