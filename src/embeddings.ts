export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
export const EMBEDDING_DIMENSION = 1024;
export const EMBED_TIMEOUT_MS = 5000;
export const EMBED_ATTEMPTS = 2;
export const RECALL_EMBED_TIMEOUT_MS = 2000;
export const RECALL_EMBED_ATTEMPTS = 1;
export const EMBED_RETRY_BACKOFF_MS = 50;

const EMBED_ENDPOINT = "/api/embed";
const FLOAT_BYTES = 4;
export const EMBEDDING_BLOB_BYTES = EMBEDDING_DIMENSION * FLOAT_BYTES;

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

export function floatsFromBlob(blob: Uint8Array): Float32Array | undefined {
  if (blob.byteLength !== EMBEDDING_BLOB_BYTES) return undefined;
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / FLOAT_BYTES);
}

export interface EmbedResult {
  available: boolean;
  embeddings: Float32Array[];
  retries: number;
}

export interface EmbedOptions {
  timeoutMs?: number;
  attempts?: number;
}

export interface EmbeddingsClient {
  embed(inputs: string[], options?: EmbedOptions): Promise<EmbedResult>;
}

export interface EmbeddingsHttpResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

export interface EmbeddingsHttpRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type FetchImplementation = (
  url: string,
  init: EmbeddingsHttpRequest,
) => Promise<EmbeddingsHttpResponse>;

export class OllamaEmbeddingsClient implements EmbeddingsClient {
  constructor(
    private readonly baseUrl: string = OLLAMA_BASE_URL,
    private readonly fetchImplementation: FetchImplementation = (url, init) => fetch(url, init),
  ) {}

  async embed(inputs: string[], options: EmbedOptions = {}): Promise<EmbedResult> {
    if (inputs.length === 0) {
      return { available: true, embeddings: [], retries: 0 };
    }
    const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS;
    const attempts = options.attempts ?? EMBED_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const embeddings = await attemptEmbed(
        this.fetchImplementation,
        this.baseUrl,
        inputs,
        timeoutMs,
      );
      if (embeddings !== undefined) {
        return { available: true, embeddings, retries: attempt };
      }
      if (attempt < attempts - 1) {
        await delay(EMBED_RETRY_BACKOFF_MS);
      }
    }
    return { available: false, embeddings: [], retries: attempts - 1 };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function attemptEmbed(
  fetchImplementation: FetchImplementation,
  baseUrl: string,
  inputs: string[],
  timeoutMs: number,
): Promise<Float32Array[] | undefined> {
  try {
    const response = await fetchImplementation(`${baseUrl}${EMBED_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return undefined;
    }
    return parseEmbeddings(await response.json(), inputs.length);
  } catch {
    return undefined;
  }
}

function parseEmbeddings(payload: unknown, expectedCount: number): Float32Array[] | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const rows = (payload as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    return undefined;
  }
  const vectors: Float32Array[] = [];
  for (const row of rows) {
    const vector = toVector(row);
    if (vector === undefined) {
      return undefined;
    }
    vectors.push(vector);
  }
  return vectors;
}

function toVector(row: unknown): Float32Array | undefined {
  if (!Array.isArray(row) || row.length !== EMBEDDING_DIMENSION) {
    return undefined;
  }
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  for (let index = 0; index < EMBEDDING_DIMENSION; index++) {
    const value = row[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    vector[index] = value;
  }
  return vector;
}
