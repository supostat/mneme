import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, defaultConfig } from "../config";
import { corpusDirFor, resolveCorpus } from "../corpus";
import type { Corpus } from "../corpus";
import { DIARY_TAG, runTag } from "../diary/diary-entries";
import type { ProcessAliveCheck } from "../diary/diary-session-facts";
import { diaryFactsTool } from "../diary/diary-tool";
import { EMBEDDING_MODEL } from "../embeddings";
import { EventWriter } from "../events";
import { initRepo, runGit } from "../git";
import { openReadOnlyDatabase } from "../index-db";
import { appendSessionStart, createSessionEndHandler } from "../mcp-server";
import { recall } from "../recall";
import { remember, REMEMBER_TOOL_SOURCE } from "../staging";
import type { StagingDeps } from "../staging";
import { workflowStartTool, workflowStepTool } from "../workflow/mcp-tools";
import { serializePhaseDocument } from "../workflow/phase-document";
import { DIARY_BRIEF_FLAG, DIARY_COMMAND, runDiaryCli } from "./diary";

// The diary CLI in process, on real modules: a real git repository, a corpus provisioned by
// resolveCorpus, a run driven to completion through the workflow tools, sessions opened by
// appendSessionStart and a manual recall that finds nothing. The subject is the line the
// UserPromptSubmit hook prints: the diary_facts brief line byte for byte when exactly one server
// session is live, a named degradation when several are, silence when there is nothing to say, a
// usage refusal only for a malformed argv — and an event log left exactly as it was.

const fixedClock = () => new Date("2026-10-30T10:00:00.000Z");
const BRIEF_ARGV = [DIARY_COMMAND, DIARY_BRIEF_FLAG];
const LIVE_SESSION = "s-live";
const OTHER_SESSION = "s-other";
const GAP_QUERY = "quantum chromodynamics lattice";
const SINGLE_STEP = [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" as const } }];
const allAlive: ProcessAliveCheck = () => true;
const noneAlive: ProcessAliveCheck = () => false;

interface CapturedInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Project {
  projectRoot: string;
  corpusHome: string;
}

async function runCli(
  argv: string[],
  project: Project,
  isProcessAlive: ProcessAliveCheck = allAlive,
): Promise<CapturedInvocation> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runDiaryCli(argv, {
    projectRoot: project.projectRoot,
    corpusHome: project.corpusHome,
    environment: {},
    isProcessAlive,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

async function buildProjectRepo(): Promise<Project> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-diary-cli-proj-"));
  await initRepo(projectRoot);
  writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return { projectRoot, corpusHome: mkdtempSync(join(tmpdir(), "mneme-diary-cli-home-")) };
}

async function provisionCorpus(project: Project): Promise<Corpus> {
  return resolveCorpus(project.projectRoot, { corpusHome: project.corpusHome, clock: fixedClock });
}

// One server session's deps: the session id is its writer's, exactly as buildServer pairs them.
function sessionDeps(project: Project, corpus: Corpus, sessionId: string): StagingDeps {
  return {
    corpus,
    projectRoot: project.projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => crypto.randomUUID(),
    embeddings: { model: EMBEDDING_MODEL, embed: async () => ({ available: false, embeddings: [], retries: 0 }) },
    eventWriter: new EventWriter(corpus.eventsDir, { sessionId, clock: fixedClock, mnemeVersion: "0.0.0" }),
  };
}

function resultText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

async function completeRun(deps: StagingDeps): Promise<string> {
  const phase = serializePhaseDocument({
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "Wire the ledger reconciliation",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
    knowledge: [],
  });
  const started = resultText(await workflowStartTool(deps, { phases: [phase], steps: SINGLE_STEP, max_iterations: 10 }));
  const runId = started.match(/Started workflow run (\S+) on branch/)![1]!;
  await workflowStepTool(deps, {});
  await workflowStepTool(deps, { run_id: runId, step_result: { phase_id: "phase-one", step_id: "implement", attempt: 1, outcome: "success" } });
  await workflowStepTool(deps, { run_id: runId, harvest_artifacts: [] });
  return runId;
}

async function recallNothing(deps: StagingDeps): Promise<void> {
  const db = openReadOnlyDatabase(deps.corpus.indexPath);
  try {
    const recalled = await recall({ db, embeddings: deps.embeddings, eventWriter: deps.eventWriter, clock: deps.clock }, GAP_QUERY, 2000, "tool-call", []);
    expect(recalled.gap).toBe(true);
  } finally {
    db.close();
  }
}

async function toolBriefLine(project: Project, corpus: Corpus, sessionId: string): Promise<string> {
  return resultText(await diaryFactsTool({ corpus, projectRoot: project.projectRoot, sessionId }, { brief: true }));
}

function eventFileBytes(corpus: Corpus): Map<string, string> {
  const bytes = new Map<string, string>();
  for (const name of readdirSync(corpus.eventsDir).sort()) {
    bytes.set(name, readFileSync(join(corpus.eventsDir, name), "utf8"));
  }
  return bytes;
}

function expectSilence(invocation: CapturedInvocation): void {
  expect(invocation.stdout).toBe("");
  expect(invocation.stderr).toBe("");
  expect(invocation.exitCode).toBe(0);
}

// A finished run without a diary entry, and one live session with an open gap.
async function scenario(): Promise<{ project: Project; corpus: Corpus; runId: string; live: StagingDeps }> {
  const project = await buildProjectRepo();
  const corpus = await provisionCorpus(project);
  const live = sessionDeps(project, corpus, LIVE_SESSION);
  const runId = await completeRun(live);
  appendSessionStart(live.eventWriter);
  await recallNothing(live);
  return { project, corpus, runId, live };
}

describe("diary --brief with one live session", () => {
  test("prints the tool's brief line for that session byte for byte, plus a newline, and leaves the log untouched", async () => {
    const { project, corpus, runId } = await scenario();
    const before = eventFileBytes(corpus);

    const invocation = await runCli(BRIEF_ARGV, project);

    expect(invocation.stdout).toBe(`${await toolBriefLine(project, corpus, LIVE_SESSION)}\n`);
    expect(invocation.stdout).toBe(
      `diary: run ${runId} complete without a diary entry · memory gaps since the last note: "${GAP_QUERY}"\n`,
    );
    expect(invocation.stderr).toBe("");
    expect(invocation.exitCode).toBe(0);
    expect(eventFileBytes(corpus)).toEqual(before);
  });

  test("a diary entry for the run and a note after the gap leave nothing to say", async () => {
    const { project, runId, live } = await scenario();
    await remember(live, { type: "decision", body: "Retro: clean first attempt.", anchors: [], tags: [DIARY_TAG, runTag(runId)], source: REMEMBER_TOOL_SOURCE });

    expectSilence(await runCli(BRIEF_ARGV, project));
  });
});

describe("diary --brief when the live session is not one", () => {
  test("no live session: the gap segment drops out and the run segment stays", async () => {
    const { project, runId } = await scenario();

    const invocation = await runCli(BRIEF_ARGV, project, noneAlive);

    expect(invocation.stdout).toBe(`diary: run ${runId} complete without a diary entry\n`);
  });

  test("a session that logged its end is not live", async () => {
    const { project, runId, live } = await scenario();
    createSessionEndHandler(live.eventWriter)();

    expect((await runCli(BRIEF_ARGV, project)).stdout).toBe(`diary: run ${runId} complete without a diary entry\n`);
  });

  test("two live sessions: the gap segment names the degradation instead of picking one", async () => {
    const { project, corpus, runId } = await scenario();
    appendSessionStart(sessionDeps(project, corpus, OTHER_SESSION).eventWriter);

    const invocation = await runCli(BRIEF_ARGV, project);

    expect(invocation.stdout).toBe(
      `diary: run ${runId} complete without a diary entry · memory gaps: n/a — 2 live sessions share this corpus\n`,
    );
  });
});

describe("diary --brief off a branch", () => {
  test("a detached HEAD drops the run segment and keeps the gaps", async () => {
    const { project } = await scenario();
    await runGit(project.projectRoot, ["checkout", "-q", "--detach"]);

    expect((await runCli(BRIEF_ARGV, project)).stdout).toBe(`diary: memory gaps since the last note: "${GAP_QUERY}"\n`);
  });
});

describe("diary --brief quiet outcomes: empty stdout, empty stderr, exit 0", () => {
  test("a project whose corpus was never provisioned — and the corpus stays unprovisioned", async () => {
    const project = await buildProjectRepo();
    const { corpusDir } = corpusDirFor(project.projectRoot, project.corpusHome);

    expectSilence(await runCli(BRIEF_ARGV, project));
    expect(existsSync(corpusDir)).toBe(false);
    expect(readdirSync(project.corpusHome)).toEqual([]);
  });

  test("a broken .mneme.json", async () => {
    const { project } = await scenario();
    writeFileSync(join(project.projectRoot, CONFIG_FILE_NAME), "{ not json");

    expectSilence(await runCli(BRIEF_ARGV, project));
  });
});

describe("diary --brief faults and grammar", () => {
  test("a corpus whose events/ is gone leaves one stderr line and still exits 0", async () => {
    const { project, corpus } = await scenario();
    rmSync(corpus.eventsDir, { recursive: true });

    const invocation = await runCli(BRIEF_ARGV, project);

    expect(invocation.stdout).toBe("");
    expect(invocation.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(invocation.exitCode).toBe(0);
  });

  test("anything but exactly `diary --brief` is refused with the usage line and exit 2", async () => {
    const project = await buildProjectRepo();

    for (const argv of [[DIARY_COMMAND], [DIARY_COMMAND, DIARY_BRIEF_FLAG, "x"], [DIARY_COMMAND, "--full"]]) {
      const invocation = await runCli(argv, project);
      expect(invocation.exitCode).toBe(2);
      expect(invocation.stdout).toBe("");
      expect(invocation.stderr).toBe(`unknown invocation "${argv.join(" ")}"\nusage: mneme diary --brief\n`);
    }
  });
});
