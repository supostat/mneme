import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, defaultConfig } from "../config";
import { corpusDirFor, resolveCorpus } from "../corpus";
import type { Corpus } from "../corpus";
import { EMBEDDING_MODEL } from "../embeddings";
import { EventWriter } from "../events";
import { initRepo, runGit } from "../git";
import type { StagingDeps } from "../staging";
import { workflowStartTool, workflowSurveyTool } from "../workflow/mcp-tools";
import { serializePhaseDocument } from "../workflow/phase-document";
import { SURVEY_BRIEF_FLAG, SURVEY_COMMAND, runSurveyCli } from "./survey";

// The survey CLI in process, on real modules: a real git repository, a real corpus provisioned by
// resolveCorpus, a real run started through the workflow tools. The subject is the contract the
// SessionStart hook relies on — the tool's brief line when the current branch has an unfinished run,
// silence (empty stdout, empty stderr, exit 0) on every quiet outcome, a usage refusal only for a
// malformed argv — and the one guarantee the tool itself cannot give: a missing corpus stays missing.

const fixedClock = () => new Date("2026-10-06T10:00:00.000Z");
const BRIEF_ARGV = [SURVEY_COMMAND, SURVEY_BRIEF_FLAG];
const SHARED_CORPUS_NAME = "shared";
const SINGLE_STEP = [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" as const } }];

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
  environment: Record<string, string | undefined> = {},
): Promise<CapturedInvocation> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runSurveyCli(argv, {
    projectRoot: project.projectRoot,
    corpusHome: project.corpusHome,
    environment,
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
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-survey-cli-proj-"));
  await initRepo(projectRoot);
  writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, [
    "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init",
  ]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return { projectRoot, corpusHome: mkdtempSync(join(tmpdir(), "mneme-survey-cli-home-")) };
}

function buildNonRepoProject(): Project {
  return {
    projectRoot: mkdtempSync(join(tmpdir(), "mneme-survey-cli-norepo-")),
    corpusHome: mkdtempSync(join(tmpdir(), "mneme-survey-cli-home-")),
  };
}

async function provisionCorpus(project: Project, corpusName?: string): Promise<Corpus> {
  return resolveCorpus(project.projectRoot, { corpusHome: project.corpusHome, corpusName, clock: fixedClock });
}

// The TOOL side needs a full StagingDeps — an EventWriter included, because starting a run writes.
// The CLI under test never sees these deps; it locates the corpus on its own.
function toolDeps(project: Project, corpus: Corpus): StagingDeps {
  return {
    corpus,
    projectRoot: project.projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => crypto.randomUUID(),
    embeddings: { model: EMBEDDING_MODEL, embed: async () => ({ available: false, embeddings: [], retries: 0 }) },
    eventWriter: new EventWriter(corpus.eventsDir, { sessionId: "s-cli", clock: fixedClock, mnemeVersion: "0.0.0" }),
  };
}

function phaseText(id: string): string {
  return serializePhaseDocument({
    id,
    deps: [],
    agentRole: "coder",
    description: `Work on ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
    knowledge: [],
  });
}

function resultText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

async function startRun(deps: StagingDeps): Promise<string> {
  const text = resultText(
    await workflowStartTool(deps, { phases: [phaseText("phase-one")], steps: SINGLE_STEP, max_iterations: 10 }),
  );
  const match = text.match(/Started workflow run (\S+) on branch/);
  if (match === null) throw new Error(`workflow_start did not report a run id:\n${text}`);
  return match[1]!;
}

async function toolBriefLine(deps: StagingDeps): Promise<string> {
  return resultText(await workflowSurveyTool(deps, { brief: true }));
}

// The log as bytes, file by file: the CLI must leave every one of them exactly as it found it.
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

describe("survey --brief with an unfinished run on the current branch", () => {
  test("prints the tool's brief line byte for byte, plus a newline, and leaves the log untouched", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project);
    const deps = toolDeps(project, corpus);
    const runId = await startRun(deps);
    const before = eventFileBytes(corpus);

    const invocation = await runCli(BRIEF_ARGV, project);

    expect(invocation.stdout).toBe(`${await toolBriefLine(deps)}\n`);
    expect(invocation.stdout).toContain(`main · run ${runId} [running]`);
    expect(invocation.stderr).toBe("");
    expect(invocation.exitCode).toBe(0);
    expect(eventFileBytes(corpus)).toEqual(before);
  });
});

describe("survey --brief quiet outcomes: empty stdout, empty stderr, exit 0", () => {
  test("a corpus with no unfinished run on the branch", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project);
    const before = eventFileBytes(corpus);

    const invocation = await runCli(BRIEF_ARGV, project);

    expectSilence(invocation);
    expect(eventFileBytes(corpus)).toEqual(before);
  });

  test("a detached HEAD, even with an unfinished run on the branch it left", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project);
    await startRun(toolDeps(project, corpus));
    await runGit(project.projectRoot, ["checkout", "-q", "--detach"]);
    const before = eventFileBytes(corpus);

    const invocation = await runCli(BRIEF_ARGV, project);

    expectSilence(invocation);
    expect(eventFileBytes(corpus)).toEqual(before);
  });

  test("a project directory that is not a git repository", async () => {
    const project = buildNonRepoProject();
    await provisionCorpus(project);

    expectSilence(await runCli(BRIEF_ARGV, project));
  });

  test("a project whose corpus was never provisioned — and the corpus stays unprovisioned", async () => {
    const project = await buildProjectRepo();
    const { corpusDir } = corpusDirFor(project.projectRoot, project.corpusHome);

    const invocation = await runCli(BRIEF_ARGV, project);

    expectSilence(invocation);
    expect(existsSync(corpusDir)).toBe(false);
    expect(readdirSync(project.corpusHome)).toEqual([]);
  });

  test("a broken .mneme.json, even with an unfinished run in the corpus", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project);
    await startRun(toolDeps(project, corpus));
    writeFileSync(join(project.projectRoot, CONFIG_FILE_NAME), "{ not json");
    const before = eventFileBytes(corpus);

    const invocation = await runCli(BRIEF_ARGV, project);

    expectSilence(invocation);
    expect(eventFileBytes(corpus)).toEqual(before);
  });
});

describe("survey --brief honours the configured corpus name", () => {
  test("corpus.name in .mneme.json addresses the named corpus, where the run is", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project, SHARED_CORPUS_NAME);
    const runId = await startRun(toolDeps(project, corpus));
    writeFileSync(join(project.projectRoot, CONFIG_FILE_NAME), JSON.stringify({ corpus: { name: SHARED_CORPUS_NAME } }));

    const invocation = await runCli(BRIEF_ARGV, project);

    expect(invocation.stdout).toContain(`main · run ${runId} [running]`);
    expect(invocation.exitCode).toBe(0);
  });

  test("MNEME_CORPUS_NAME in the environment addresses the named corpus the same way", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project, SHARED_CORPUS_NAME);
    const runId = await startRun(toolDeps(project, corpus));

    const named = await runCli(BRIEF_ARGV, project, { MNEME_CORPUS_NAME: SHARED_CORPUS_NAME });
    const unnamed = await runCli(BRIEF_ARGV, project);

    expect(named.stdout).toContain(`main · run ${runId} [running]`);
    // Without the name the munged directory does not exist, so the run is invisible — the line
    // above came from the name, not from a coincidence of layout.
    expectSilence(unnamed);
  });
});

describe("survey argv grammar", () => {
  test.each([
    [["survey"]],
    [["survey", "--brief", "x"]],
    [["doctor"]],
  ])("%j is refused with a usage line on stderr and exit 2, nothing on stdout", async (argv) => {
    const project = await buildProjectRepo();

    const invocation = await runCli(argv, project);

    expect(invocation.exitCode).toBe(2);
    expect(invocation.stdout).toBe("");
    expect(invocation.stderr).toContain(`usage: mneme ${SURVEY_COMMAND} ${SURVEY_BRIEF_FLAG}`);
  });
});

describe("survey --brief on an unforeseen fault", () => {
  test("a corpus whose events/ is gone: empty stdout, ONE diagnostic line on stderr, exit 0", async () => {
    const project = await buildProjectRepo();
    const corpus = await provisionCorpus(project);
    rmSync(corpus.eventsDir, { recursive: true, force: true });

    const invocation = await runCli(BRIEF_ARGV, project);

    expect(invocation.stdout).toBe("");
    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr.endsWith("\n")).toBe(true);
    expect(invocation.stderr.trimEnd().split("\n")).toHaveLength(1);
  });
});
