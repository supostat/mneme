import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActiveNotes } from "../src/active-notes";
import { loadConfig } from "../src/config";
import type { ConfigEnvironment } from "../src/config";
import { adoptCorpus } from "../src/corpus-adopt";
import { resolveCorpus } from "../src/corpus";
import { EMBEDDING_DIMENSION, HttpEmbeddingsClient } from "../src/embeddings";
import type { EmbeddingsHttpRequest, FetchImplementation } from "../src/embeddings";
import { EventWriter, readEvents } from "../src/events";
import type { StoredEvent } from "../src/events";
import { initRepo, runGit } from "../src/git";
import { HttpJudgeClient, JUDGE_BASE_URL, JUDGE_ENDPOINT_PATH, JUDGE_MODEL } from "../src/judge";
import type { JudgeClient } from "../src/judge";
import { formatAdoption, formatRemember, formatStagingList } from "../src/mcp-rendering";
import { remember, stagingList, stagingResolve } from "../src/staging";
import type { StagingDeps } from "../src/staging";

// The wire test of the judge: a real project repository, a real corpus through resolveCorpus, real
// config, staging with its human gate, the SQLite index, the corpus git, the event log and
// adoption. The two stand-ins sit at the network boundary only — the embedder's fetch (one axis per
// body, so every pair is orthogonal and the cosine path classifies an `add` with a far neighbour)
// and the judge's fetch, a System One that reads two notes about the ROSTER as a supersede and any
// other pair as unrelated. The judge client itself is the real HttpJudgeClient, built from the real
// config exactly as the server builds it: present when MNEME_JUDGE_API_KEY is set, absent otherwise.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const E2E_TIMEOUT_MS = 60000;
const API_KEY = "apikey-e2e-canary";
const ROSTER_MARKER = "ROSTER";
const SUPERSEDES = { duplicate: 0, supersedes: 0.9, contradicts: 0.05, complements: 0.05, unrelated: 0 };
const UNRELATED = { duplicate: 0, supersedes: 0, contradicts: 0, complements: 0.05, unrelated: 0.95 };

const EIGHT_CARDS = `Decision: the landing ${ROSTER_MARKER} has eight cards: setup, grill, plan, fix.`;
const NINE_CARDS = `Decision: the landing ${ROSTER_MARKER} has nine cards: setup, grill, plan, fix, design.`;
const TEN_CARDS = `Decision: the landing ${ROSTER_MARKER} has ten cards, map and diary joined.`;

function ulid(n: number): string {
  return "01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32]! + CROCKFORD[n % 32]!;
}

function sequentialIds(start: number): () => string {
  let counter = start;
  return () => ulid(counter++);
}

const fixedClock = () => new Date("2026-11-08T10:00:00.000Z");

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// One axis per body: the three bodies this test stages get fixed, distinct axes, so no two of them
// can collide into a cosine of 1 (a noop) by hash accident; anything else hashes to an axis.
const AXES = new Map<string, number>([
  [EIGHT_CARDS, 1],
  [NINE_CARDS, 2],
  [TEN_CARDS, 3],
]);

function oneHotFetch(): FetchImplementation {
  return async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { input: string[] };
    const embeddings = payload.input.map((text) => {
      const vector = new Array(EMBEDDING_DIMENSION).fill(0);
      vector[AXES.get(text) ?? 8 + (hashText(text) % (EMBEDDING_DIMENSION - 8))] = 1;
      return vector;
    });
    return { ok: true, json: async () => ({ embeddings }) };
  };
}

function embedder(): HttpEmbeddingsClient {
  return new HttpEmbeddingsClient("http://embedder.test", oneHotFetch(), "test-model", "ollama");
}

interface JudgeCall {
  url: string;
  authorization: string | undefined;
  model: string;
}

// A System One stand-in: two notes that both talk about the roster are read as a supersede; any
// other pair is unrelated. It records what the real client sent.
function rosterJudgeFetch(calls: JudgeCall[]): FetchImplementation {
  return async (url, init: EmbeddingsHttpRequest) => {
    const body = JSON.parse(init.body) as { model: string; state: { note_a: { body: string }; note_b: { body: string } } };
    calls.push({ url, authorization: init.headers["authorization"], model: body.model });
    const bothRoster = body.state.note_a.body.includes(ROSTER_MARKER) && body.state.note_b.body.includes(ROSTER_MARKER);
    const answer = bothRoster
      ? { type: "choice", choice: "supersedes", probabilities: SUPERSEDES, confidence: 0.9 }
      : { type: "choice", choice: "unrelated", probabilities: UNRELATED, confidence: 0.9 };
    return { ok: true, json: async () => ({ model: "jev-1.14.0", answers: { relation: answer } }) };
  };
}

function outageJudgeFetch(): FetchImplementation {
  return async () => {
    throw new TypeError("connection refused");
  };
}

async function workingCopy(prefix: string): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  await initRepo(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "landing.ts"), "export const landing = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return projectRoot;
}

// The dependency assembly the server performs: config first (the judge exists exactly when the key
// does), then the corpus, then the clients built from the config's own endpoint and model.
async function sessionIn(
  projectRoot: string,
  corpusHome: string,
  idStart: number,
  environment: ConfigEnvironment,
  judgeFetch: FetchImplementation,
): Promise<StagingDeps> {
  const config = loadConfig(projectRoot, environment);
  const corpus = await resolveCorpus(projectRoot, { corpusHome, corpusName: config.corpus.name, clock: fixedClock });
  const judge: JudgeClient | undefined =
    config.judge.apiKey === undefined
      ? undefined
      : new HttpJudgeClient(config.judge.baseUrl, judgeFetch, config.judge.model, config.judge.apiKey);
  return {
    corpus,
    projectRoot,
    config,
    clock: fixedClock,
    idFactory: sequentialIds(idStart),
    embeddings: embedder(),
    eventWriter: new EventWriter(corpus.eventsDir, { sessionId: `s-${idStart}`, mnemeVersion: "0.1.19", clock: fixedClock }),
    judge,
  };
}

async function acceptNote(deps: StagingDeps, body: string): Promise<string> {
  const staged = await remember(deps, { type: "decision", body, anchors: ["src/landing.ts"], source: "e2e" });
  if (staged.outcome !== "staged") throw new Error(`expected a staged note, got ${staged.outcome}`);
  const resolved = await stagingResolve(deps, staged.noteId, "accept");
  if (resolved.outcome !== "accepted") throw new Error(`expected an accepted note, got ${resolved.outcome}`);
  return staged.noteId;
}

function rememberEventOf(deps: StagingDeps, noteId: string): StoredEvent {
  const event = readEvents(deps.corpus.eventsDir).find((candidate) => candidate.type === "remember" && candidate.note_id === noteId);
  if (event === undefined) throw new Error(`no remember event for ${noteId}`);
  return event;
}

function sidecarOf(deps: StagingDeps, noteId: string): { nearest_id: unknown; judge: unknown } {
  return JSON.parse(readFileSync(join(deps.corpus.stagingDir, `${noteId}.dedup.json`), "utf8")) as { nearest_id: unknown; judge: unknown };
}

describe("the judge on the staging path, end to end", () => {
  test("a recommendation travels from remember to the card and the log, the human supersedes, and an adoption is flagged", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-judge-home-"));
    const calls: JudgeCall[] = [];
    const session = await sessionIn(await workingCopy("mneme-judge-a-"), corpusHome, 1, { MNEME_JUDGE_API_KEY: API_KEY }, rosterJudgeFetch(calls));

    const eightCards = await acceptNote(session, EIGHT_CARDS);
    expect(calls).toEqual([]);

    // A below-threshold neighbour (orthogonal vectors, cosine 0): the cosine path classifies an add
    // and the card would say "no close neighbor" — the judge reads the pair as a supersede.
    const staged = await remember(session, { type: "decision", body: NINE_CARDS, anchors: ["src/landing.ts"], source: "e2e" });
    if (staged.outcome !== "staged") throw new Error(`expected a staged note, got ${staged.outcome}`);
    const nineCards = staged.noteId;

    expect(calls).toEqual([{ url: `${JUDGE_BASE_URL}${JUDGE_ENDPOINT_PATH}`, authorization: `Bearer ${API_KEY}`, model: JUDGE_MODEL }]);
    expect(staged.dedup).toBe("add");
    expect(staged.nearestId).toBeNull();
    expect(staged.judge).toEqual({
      degraded: false,
      model: JUDGE_MODEL,
      neighborId: eightCards,
      relation: "supersedes",
      probabilities: SUPERSEDES,
      confidence: 0.9,
      recommended: true,
    });
    expect(formatRemember(staged).split("\n")[1]).toBe(
      `The judge reads it as superseding ${eightCards} (supersedes 0.90); the human may choose to supersede that note.`,
    );

    const cardLines = formatStagingList(await stagingList(session), [], []).split("\n");
    const cosineLine = cardLines.indexOf("no close neighbor");
    expect(cosineLine).toBeGreaterThan(0);
    expect(cardLines[cosineLine + 1]).toBe(`judge: supersedes 0.90 — recommends supersede of ${eightCards}`);
    expect(cardLines[cosineLine + 2]).toBe("anchors: src/landing.ts [tracked]");

    const dedup = rememberEventOf(session, nineCards).dedup as { outcome: string; nearest_id: string; judge: Record<string, unknown> };
    expect(dedup.outcome).toBe("add");
    expect(dedup.nearest_id).toBe(eightCards);
    expect(dedup.judge).toEqual({
      model: JUDGE_MODEL,
      relation: "supersedes",
      probabilities: SUPERSEDES,
      confidence: 0.9,
      recommended: true,
      degraded: false,
    });

    // The human follows the recommendation. `suggested` is the COSINE's word, untouched by the judge:
    // the cosine never offered this neighbour, so it stays false.
    const superseded = await stagingResolve(session, nineCards, { supersede: eightCards });
    expect(superseded.outcome).toBe("superseded");
    if (superseded.outcome === "superseded") {
      expect(superseded.supersededId).toBe(eightCards);
      expect(superseded.suggested).toBe(false);
    }
    expect(readActiveNotes(session.corpus.notesDir).map((note) => note.frontmatter.id)).toEqual([nineCards]);

    // A corpus that drifted apart holds a third roster note; adoption crosses the human gate by
    // design, so the judge's reading is flagged in the report and counted on the event.
    const drifted = await sessionIn(await workingCopy("mneme-judge-drifted-"), corpusHome, 100, {}, outageJudgeFetch());
    const tenCards = await acceptNote(drifted, TEN_CARDS);

    const adoption = await adoptCorpus(session, drifted.corpus.corpusDir);

    expect(adoption.adoptedCount).toBe(1);
    const adopted = adoption.notes.find((note) => note.id === tenCards);
    expect(adopted?.judge).toEqual({
      degraded: false,
      model: JUDGE_MODEL,
      neighborId: nineCards,
      relation: "supersedes",
      probabilities: SUPERSEDES,
      confidence: 0.9,
      recommended: true,
    });
    expect(formatAdoption(adoption).split("\n")).toContain(`judge flags ${tenCards} as supersedes (0.90) against ${nineCards}`);
    const adoptedEvent = readEvents(session.corpus.eventsDir).find((event) => event.type === "corpus_adopted");
    expect(adoptedEvent?.judge_flagged_n).toBe(1);
    expect(adoptedEvent?.adopted_n).toBe(1);
  }, E2E_TIMEOUT_MS);

  test("without the key nothing changes: no call, no line, null in the sidecar and the log", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-judge-home-"));
    const calls: JudgeCall[] = [];
    const session = await sessionIn(await workingCopy("mneme-judge-nokey-"), corpusHome, 1, {}, rosterJudgeFetch(calls));
    expect(session.judge).toBeUndefined();

    const eightCards = await acceptNote(session, EIGHT_CARDS);
    const staged = await remember(session, { type: "decision", body: NINE_CARDS, anchors: ["src/landing.ts"], source: "e2e" });
    if (staged.outcome !== "staged") throw new Error(`expected a staged note, got ${staged.outcome}`);

    expect(calls).toEqual([]);
    expect(staged.judge).toBeNull();
    expect(formatRemember(staged).split("\n")[1]).toBe("No close existing note was found.");
    const card = formatStagingList(await stagingList(session), [], []);
    expect(card).toContain("no close neighbor");
    expect(card).not.toContain("judge");
    const sidecar = sidecarOf(session, staged.noteId);
    expect(sidecar.nearest_id).toBeNull();
    expect(sidecar.judge).toBeNull();
    const dedup = rememberEventOf(session, staged.noteId).dedup as { nearest_id: string; judge: unknown };
    expect(dedup.nearest_id).toBe(eightCards);
    expect(dedup.judge).toBeNull();
  }, E2E_TIMEOUT_MS);

  test("a judge outage degrades the verdict and never blocks the note", async () => {
    const corpusHome = mkdtempSync(join(tmpdir(), "mneme-judge-home-"));
    const session = await sessionIn(await workingCopy("mneme-judge-outage-"), corpusHome, 1, { MNEME_JUDGE_API_KEY: API_KEY }, outageJudgeFetch());

    const eightCards = await acceptNote(session, EIGHT_CARDS);
    const staged = await remember(session, { type: "decision", body: NINE_CARDS, anchors: ["src/landing.ts"], source: "e2e" });
    if (staged.outcome !== "staged") throw new Error(`expected a staged note, got ${staged.outcome}`);

    expect(staged.judge).toEqual({ degraded: true, model: JUDGE_MODEL, neighborId: eightCards });
    expect(existsSync(join(session.corpus.stagingDir, `${staged.noteId}.md`))).toBe(true);
    expect(formatRemember(staged).split("\n")[1]).toBe("No close existing note was found.");
    expect(formatStagingList(await stagingList(session), [], []).split("\n")).toContain("judge: unavailable");
    const dedup = rememberEventOf(session, staged.noteId).dedup as { judge: Record<string, unknown> };
    expect(dedup.judge).toEqual({ model: JUDGE_MODEL, relation: null, probabilities: null, confidence: null, recommended: null, degraded: true });
  }, E2E_TIMEOUT_MS);
});
