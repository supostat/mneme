import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/dispatch";
import { DIARY_BRIEF_FLAG, DIARY_COMMAND, runDiaryCli } from "../src/cli/diary";
import { defaultConfig } from "../src/config";
import { resolveCorpus } from "../src/corpus";
import { DIARY_TAG, RUN_TAG_PREFIX } from "../src/diary/diary-entries";
import { DIARY_BRIEF_NOTHING, renderDiaryLine, renderRunAnswer, renderSessionFacts } from "../src/diary/diary-rendering";
import { runFacts } from "../src/diary/diary-run-facts";
import type { RunFacts } from "../src/diary/diary-run-facts";
import type { MemoryGap, SessionFacts } from "../src/diary/diary-session-facts";
import { diaryFactsTool } from "../src/diary/diary-tool";
import type { DiaryToolDeps } from "../src/diary/diary-tool";
import { EMBEDDING_MODEL } from "../src/embeddings";
import { EventWriter, readEvents } from "../src/events";
import { initRepo, runGit } from "../src/git";
import type { StagingDeps } from "../src/staging";
import { workflowStartTool } from "../src/workflow/mcp-tools";
import { serializePhaseDocument } from "../src/workflow/phase-document";

// The handoff document tells the plugin's diary skill and its prompt hook which tool to grant, which
// tags mark a diary entry, which subcommand the hook runs and — line by line — what every answer
// looks like, so it quotes the engine's own names and texts. This guard pins COVERAGE the
// handoff-map way: every name is read off the SOURCE (a rename in the engine turns into a red suite,
// never a guard that keeps passing against a stale literal) and must appear verbatim between
// backticks; and every quoted line ROUND-TRIPS — the template is taken as the document writes it,
// its placeholders are filled with sample values, and the real renderer, fold, tool or CLI must
// print exactly that line for the same values. Prose is deliberately not asserted.

const REPO_ROOT = join(import.meta.dir, "..");
const HANDOFF_PATH = join(REPO_ROOT, "docs", "HANDOFF-DIARY.md");
const MARKERS = [
  "HANDOFF-DIARY-TAGS",
  "HANDOFF-DIARY-TOOL",
  "HANDOFF-DIARY-BRIEF",
  "HANDOFF-DIARY-CLI",
  "HANDOFF-DIARY-SKILLS",
];
const ANGLE_PLACEHOLDER = /<[^<>]+>/g;
const CODE_FENCE = "```";
const fixedClock = () => new Date("2026-10-30T10:00:00.000Z");
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const GHOST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FX0";
const SESSION_ID = "s-handoff-diary";

// The registration line binds the tool name to its description constant; the input schema binds the
// two field names to their zod types; the CLI and entries modules export their words as string
// constants. Every regex fails LOUDLY when the source moves out from under it.
const TOOL_REGISTRATION_PATTERN = /registerTool\("([a-z_]+)", \{ description: DIARY_FACTS_DESCRIPTION/;
const TOOL_INPUT_PATTERN =
  /export const DIARY_FACTS_INPUT = \{\s*([a-z_]+): z\.string\(\)\.optional\(\),\s*([a-z_]+): z\.boolean\(\)\.optional\(\)/;
const CLI_COMMAND_PATTERN = /export const DIARY_COMMAND = "([a-z]+)"/;
const CLI_BRIEF_FLAG_PATTERN = /export const DIARY_BRIEF_FLAG = "(--[a-z]+)"/;
const DIARY_TAG_PATTERN = /export const DIARY_TAG = "([a-z]+)"/;
const RUN_TAG_PREFIX_PATTERN = /export const RUN_TAG_PREFIX = "([a-z]+:)"/;

function handoffDocument(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

function sourceOf(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), "utf8");
}

function captured(pattern: RegExp, source: string, what: string): string {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) {
    throw new Error(`${what} is no longer where the guard reads it`);
  }
  return value;
}

interface ContractNames {
  tool: string;
  runIdField: string;
  briefField: string;
  command: string;
  flag: string;
  diaryTag: string;
  runTagPrefix: string;
}

function contractNames(): ContractNames {
  const serverSource = sourceOf("src", "mcp-server.ts");
  const toolSource = sourceOf("src", "diary", "diary-tool.ts");
  const cliSource = sourceOf("src", "cli", "diary.ts");
  const entriesSource = sourceOf("src", "diary", "diary-entries.ts");
  const input = TOOL_INPUT_PATTERN.exec(toolSource);
  if (input === null) {
    throw new Error("the diary_facts input schema is no longer where the guard reads it");
  }
  return {
    tool: captured(TOOL_REGISTRATION_PATTERN, serverSource, "the diary_facts registration"),
    runIdField: input[1]!,
    briefField: input[2]!,
    command: captured(CLI_COMMAND_PATTERN, cliSource, "the diary CLI command"),
    flag: captured(CLI_BRIEF_FLAG_PATTERN, cliSource, "the diary CLI brief flag"),
    diaryTag: captured(DIARY_TAG_PATTERN, entriesSource, "the diary tag"),
    runTagPrefix: captured(RUN_TAG_PREFIX_PATTERN, entriesSource, "the run tag prefix"),
  };
}

interface Workbench {
  deps: StagingDeps;
  toolDeps: DiaryToolDeps;
  runningRunId: string;
}

// A real corpus with one run still running on main and one ghost step event, so the tool answers
// the session form, the brief, the "still running" and the "cannot be read" refusals for real.
async function makeWorkbench(): Promise<Workbench> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-handoff-diary-proj-"));
  await initRepo(projectRoot);
  writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
  await runGit(projectRoot, ["add", "."]);
  const committed = await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  const corpus = await resolveCorpus(projectRoot, { corpusHome: mkdtempSync(join(tmpdir(), "mneme-handoff-diary-home-")), clock: fixedClock });
  const eventWriter = new EventWriter(corpus.eventsDir, { sessionId: SESSION_ID, clock: fixedClock, mnemeVersion: "0.0.0" });
  const deps: StagingDeps = {
    corpus,
    projectRoot,
    config: defaultConfig(),
    clock: fixedClock,
    idFactory: () => crypto.randomUUID(),
    embeddings: { model: EMBEDDING_MODEL, embed: async () => ({ available: false, embeddings: [], retries: 0 }) },
    eventWriter,
  };
  const phase = serializePhaseDocument({
    id: "phase-one",
    deps: [],
    agentRole: "coder",
    description: "Work on phase-one",
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "always green", command: "true", timeoutSeconds: null }],
    knowledge: [],
  });
  const started = await workflowStartTool(deps, {
    phases: [phase],
    steps: [{ id: "implement", max_attempts: 1, on_fail: { action: "escalate" } }],
    max_iterations: 10,
  });
  const runningRunId = toolText(started).match(/Started workflow run (\S+) on branch/)![1]!;
  eventWriter.append({
    type: "workflow_step_applied",
    run_id: GHOST_RUN_ID,
    branch: "main",
    phase_id: "phase-one",
    result_kind: "recall",
    step_id: null,
    outcome: null,
    attempt: null,
    gates: null,
    harvested_n: null,
  });
  return { deps, toolDeps: { corpus, projectRoot, sessionId: SESSION_ID }, runningRunId };
}

function toolText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

async function toolAnswer(workbench: Workbench, args: { run_id?: string; brief?: boolean }): Promise<string> {
  return toolText(await diaryFactsTool(workbench.toolDeps, args));
}

async function cliStderr(argv: string[], workbench: Workbench, dispatch: boolean): Promise<string> {
  let stderr = "";
  const options = {
    projectRoot: workbench.deps.projectRoot,
    environment: {},
    isProcessAlive: () => true,
    stdout: () => {},
    stderr: (text: string) => {
      stderr += text;
    },
  };
  await (dispatch ? runCli(argv, options) : runDiaryCli(argv, options));
  return stderr;
}

function runFactsFixture(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    runId: RUN_ID,
    branch: "main",
    status: "escalated",
    startedTs: "2026-10-30T10:00:00.000Z",
    endedTs: "2026-10-30T11:00:00.000Z",
    iterationsUsed: 3,
    maxIterations: 20,
    diaryEntry: false,
    escalation: { phaseId: "schema", stepId: "implement", reason: "retry_budget_exhausted" },
    curation: { staged: 1, accepted: 1, rejected: 1, superseded: 0, uninstrumentedHarvests: 2 },
    phases: [
      {
        phaseId: "schema",
        reached: true,
        attempts: 2,
        bundleGap: true,
        harvest: { kind: "run", stagedByType: [{ type: "bugfix", count: 1 }, { type: "decision", count: 2 }], harvestedCount: 3, usedNotes: 1 },
        gateFailures: [
          { attempt: 1, kind: "executable", criterion: "unit tests pass", reason: "exit-nonzero", remarks: [] },
          { attempt: 1, kind: "agent-judged", criterion: "review approves", reason: "fail votes 1/2", remarks: ["the noop path is untested"] },
        ],
      },
      {
        phaseId: "facts",
        reached: true,
        attempts: 1,
        bundleGap: null,
        harvest: { kind: "run", stagedByType: null, harvestedCount: 2, usedNotes: null },
        gateFailures: [],
      },
      { phaseId: "tool", reached: true, attempts: 1, bundleGap: false, harvest: { kind: "not-run" }, gateFailures: [] },
      { phaseId: "cli", reached: false, attempts: 0, bundleGap: null, harvest: { kind: "not-run" }, gateFailures: [] },
    ],
    ...overrides,
  };
}

function gap(query: string, open: boolean): MemoryGap {
  return { ts: "2026-10-30T10:05:00.000Z", query, open };
}

function sessionFixture(gaps: MemoryGap[]): SessionFacts {
  return { sessionId: SESSION_ID, recalls: 4, notes: 1, gaps };
}

const UNDIARIED = { runId: RUN_ID, status: "complete" as const, diaryEntry: false };
const BRANCH_UNDIARIED = { kind: "branch" as const, branch: "main", lastTerminal: UNDIARIED };

interface RoundTrip {
  template: string;
  placeholderValues: Record<string, string>;
  engineText: () => Promise<string> | string;
}

function roundTrips(workbench: Workbench): RoundTrip[] {
  const runForm = () => renderRunAnswer({ kind: "facts", facts: runFactsFixture() });
  const runFormWithEntry = () => renderRunAnswer({ kind: "facts", facts: runFactsFixture({ diaryEntry: true }) });
  const sessionForm = () => renderSessionFacts(sessionFixture([gap("first question", false), gap("second question", true)]), BRANCH_UNDIARIED);
  const emptySessionForm = () => renderSessionFacts(sessionFixture([]), { kind: "branch", branch: "main", lastTerminal: null });
  return [
    {
      template: 'Diary facts for run <run_id> on branch "<branch>". Nothing was written: no event, no file, no stale mark.',
      placeholderValues: { "<run_id>": RUN_ID, "<branch>": "main" },
      engineText: runForm,
    },
    {
      template: "status <status> · started <started_ts> · ended <ended_ts> · iterations <used>/<max>",
      placeholderValues: { "<status>": "escalated", "<started_ts>": "2026-10-30T10:00:00.000Z", "<ended_ts>": "2026-10-30T11:00:00.000Z", "<used>": "3", "<max>": "20" },
      engineText: runForm,
    },
    { template: "diary entry: none", placeholderValues: {}, engineText: runForm },
    { template: "diary entry: present", placeholderValues: {}, engineText: runFormWithEntry },
    {
      template: "escalation: <phase_id>/<step_id> — <reason>",
      placeholderValues: { "<phase_id>": "schema", "<step_id>": "implement", "<reason>": "retry_budget_exhausted" },
      engineText: runForm,
    },
    {
      template: "curation: staged <staged> · accepted <accepted> · rejected <rejected> · superseded <superseded>",
      placeholderValues: { "<staged>": "1", "<accepted>": "1", "<rejected>": "1", "<superseded>": "0" },
      engineText: runForm,
    },
    { template: "curation: <k> harvest(s) before schema v22 not counted", placeholderValues: { "<k>": "2" }, engineText: runForm },
    { template: "phase <phase_id>: not reached", placeholderValues: { "<phase_id>": "cli" }, engineText: runForm },
    {
      template: "phase <phase_id>: attempts <n> · bundle gap <gap> · harvest <kinds> · used notes <used>",
      placeholderValues: { "<phase_id>": "schema", "<n>": "2", "<gap>": "yes", "<kinds>": "bugfix 1, decision 2", "<used>": "1" },
      engineText: runForm,
    },
    {
      template: "phase <phase_id>: attempts <n> · bundle gap not instrumented · harvest <staged> staged, kinds not instrumented · used notes not instrumented",
      placeholderValues: { "<phase_id>": "facts", "<n>": "1", "<staged>": "2" },
      engineText: runForm,
    },
    {
      template: "phase <phase_id>: attempts <n> · bundle gap <gap> · harvest not run · used notes not run",
      placeholderValues: { "<phase_id>": "tool", "<n>": "1", "<gap>": "no" },
      engineText: runForm,
    },
    {
      template: "  gate fail · attempt <n> · <kind> · <criterion> · <reason>",
      placeholderValues: { "<n>": "1", "<kind>": "agent-judged", "<criterion>": "review approves", "<reason>": "fail votes 1/2" },
      engineText: runForm,
    },
    { template: "  remark: <text>", placeholderValues: { "<text>": "the noop path is untested" }, engineText: runForm },
    {
      template: "Diary facts for session <session_id>. Nothing was written: no event, no file, no stale mark.",
      placeholderValues: { "<session_id>": SESSION_ID },
      engineText: sessionForm,
    },
    {
      template: "recalls <recalls> · memory gaps <gaps> · notes <notes>",
      placeholderValues: { "<recalls>": "4", "<gaps>": "2", "<notes>": "1" },
      engineText: sessionForm,
    },
    { template: "memory gaps: none", placeholderValues: {}, engineText: emptySessionForm },
    { template: "memory gaps, oldest first:", placeholderValues: {}, engineText: sessionForm },
    {
      template: '- <ts> "<query>"',
      placeholderValues: { "<ts>": "2026-10-30T10:05:00.000Z", "<query>": "first question" },
      engineText: sessionForm,
    },
    {
      template: '- <ts> "<query>" (open)',
      placeholderValues: { "<ts>": "2026-10-30T10:05:00.000Z", "<query>": "second question" },
      engineText: sessionForm,
    },
    {
      template: 'last terminal run on branch "<branch>": <run_id> [<status>] without a diary entry',
      placeholderValues: { "<branch>": "main", "<run_id>": RUN_ID, "<status>": "complete" },
      engineText: sessionForm,
    },
    {
      template: 'last terminal run on branch "<branch>": <run_id> [<status>] has a diary entry',
      placeholderValues: { "<branch>": "main", "<run_id>": RUN_ID, "<status>": "complete" },
      engineText: () => renderSessionFacts(sessionFixture([]), { ...BRANCH_UNDIARIED, lastTerminal: { ...UNDIARIED, diaryEntry: true } }),
    },
    {
      template: 'no terminal run on branch "<branch>"',
      placeholderValues: { "<branch>": "main" },
      engineText: () => toolAnswer(workbench, {}),
    },
    {
      template: "HEAD is detached: no branch to look up a terminal run on.",
      placeholderValues: {},
      engineText: () => renderSessionFacts(sessionFixture([]), { kind: "detached" }),
    },
    {
      template: "git failed to resolve the current branch: no terminal run to look up.",
      placeholderValues: {},
      engineText: () => renderSessionFacts(sessionFixture([]), { kind: "git-error" }),
    },
    {
      template: 'diary: run <run_id> <status> without a diary entry · memory gaps since the last note: "<q1>", "<q2>"',
      placeholderValues: { "<run_id>": RUN_ID, "<status>": "complete", "<q1>": "q1", "<q2>": "q2" },
      engineText: () => renderDiaryLine(UNDIARIED, { kind: "session", facts: sessionFixture([gap("q1", true), gap("q2", true)]) }) ?? "",
    },
    {
      template: 'diary: memory gaps since the last note: "<q1>", "<q2>", "<q3>", "<q4>", "<q5>" (+<k> earlier)',
      placeholderValues: { "<q1>": "q3", "<q2>": "q4", "<q3>": "q5", "<q4>": "q6", "<q5>": "q7", "<k>": "2" },
      engineText: () =>
        renderDiaryLine(null, { kind: "session", facts: sessionFixture(["q1", "q2", "q3", "q4", "q5", "q6", "q7"].map((query) => gap(query, true))) }) ?? "",
    },
    {
      template: "diary: run <run_id> <status> without a diary entry · memory gaps: n/a — <n> live sessions share this corpus",
      placeholderValues: { "<run_id>": RUN_ID, "<status>": "complete", "<n>": "2" },
      engineText: () => renderDiaryLine(UNDIARIED, { kind: "shared", liveSessions: 2 }) ?? "",
    },
    { template: DIARY_BRIEF_NOTHING, placeholderValues: {}, engineText: () => toolAnswer(workbench, { brief: true }) },
    {
      template: "run_id is not a ULID or UUID. Nothing was written.",
      placeholderValues: {},
      engineText: () => toolAnswer(workbench, { run_id: "../not-a-run" }),
    },
    {
      template: "No workflow run <run_id> in this corpus. Nothing was written.",
      placeholderValues: { "<run_id>": RUN_ID },
      engineText: () => toolAnswer(workbench, { run_id: RUN_ID }),
    },
    {
      template: "Run <run_id> cannot be read from the log: <problem>. Nothing was written.",
      placeholderValues: { "<run_id>": GHOST_RUN_ID, "<problem>": "workflow_step_applied without a preceding workflow_run_started" },
      engineText: () => renderRunAnswer(runFacts(readEvents(workbench.deps.corpus.eventsDir), GHOST_RUN_ID)),
    },
    {
      template: 'Run <run_id> is still running on branch "<branch>": diary facts describe a finished run. Nothing was written.',
      placeholderValues: { "<run_id>": workbench.runningRunId, "<branch>": "main" },
      engineText: () => toolAnswer(workbench, { run_id: workbench.runningRunId }),
    },
    {
      template: "brief describes the session only: pass brief or run_id, not both. Nothing was written.",
      placeholderValues: {},
      engineText: () => toolAnswer(workbench, { run_id: workbench.runningRunId, brief: true }),
    },
    {
      template: `usage: mneme ${DIARY_COMMAND} ${DIARY_BRIEF_FLAG}`,
      placeholderValues: {},
      engineText: () => cliStderr([DIARY_COMMAND], workbench, false),
    },
    {
      template: 'unknown invocation "<argv>"',
      placeholderValues: { "<argv>": "doctor" },
      engineText: () => cliStderr(["doctor"], workbench, true),
    },
  ];
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One pass over the template, so a substituted value is never rewritten by a later placeholder. A
// placeholder without a sample value, or a value whose placeholder the template does not hold, is a
// guard bug and fails loudly.
function fillTemplate(template: string, placeholderValues: Record<string, string>): string {
  const placeholders = Object.keys(placeholderValues);
  const unvalued = (template.match(ANGLE_PLACEHOLDER) ?? []).filter((placeholder) => !(placeholder in placeholderValues));
  if (unvalued.length > 0) {
    throw new Error(`"${template}" has placeholders without a sample value: ${unvalued.join(", ")}`);
  }
  if (placeholders.length === 0) return template;
  const pattern = new RegExp(`(?:${placeholders.map(escapeForPattern).join("|")})`, "g");
  const filled = new Set<string>();
  const text = template.replace(pattern, (placeholder) => {
    filled.add(placeholder);
    return placeholderValues[placeholder]!;
  });
  const unused = placeholders.filter((placeholder) => !filled.has(placeholder));
  if (unused.length > 0) {
    throw new Error(`"${template}" does not hold the placeholders ${unused.join(", ")}`);
  }
  return text;
}

function holdsWholeLines(text: string, lines: string): boolean {
  return `\n${text}\n`.includes(`\n${lines}\n`);
}

describe("HANDOFF-DIARY contract coverage", () => {
  test("the guard reads every name off the source (the guard's own guard)", () => {
    const names = contractNames();

    expect(names).toEqual({
      tool: "diary_facts",
      runIdField: "run_id",
      briefField: "brief",
      command: DIARY_COMMAND,
      flag: DIARY_BRIEF_FLAG,
      diaryTag: DIARY_TAG,
      runTagPrefix: RUN_TAG_PREFIX,
    });
  });

  test("every engine name appears in the handoff document as a backticked token", () => {
    const document = handoffDocument();

    const missing = Object.values(contractNames()).filter((name) => !document.includes(`\`${name}\``));

    expect(missing).toEqual([]);
  });

  test("the hook's invocation is quoted as a code block built from the CLI's own words", () => {
    const document = handoffDocument();

    expect(document).toContain(`${CODE_FENCE}\nmneme ${DIARY_COMMAND} ${DIARY_BRIEF_FLAG}\n${CODE_FENCE}`);
  });

  test("each documented section carries its anchor marker, so a rewrite cannot drop one silently", () => {
    const document = handoffDocument();

    for (const marker of MARKERS) {
      expect(document).toContain(`<!-- ${marker} -->`);
    }
  });
});

describe("HANDOFF-DIARY quoted lines round-trip through the engine", () => {
  let workbench: Workbench;

  beforeAll(async () => {
    workbench = await makeWorkbench();
  });

  test("every round-tripped template is quoted verbatim between backticks, each once", () => {
    const document = handoffDocument();
    const templates = roundTrips(workbench).map((roundTrip) => roundTrip.template);

    const unquoted = templates.filter((template) => !document.includes(`\`${template}\``));

    expect(unquoted).toEqual([]);
    expect(new Set(templates).size).toBe(templates.length);
  });

  test("each template filled with sample values is a whole line the real renderer, fold, tool or CLI prints for them", async () => {
    const mismatches: Array<{ expected: string; engineText: string }> = [];

    for (const roundTrip of roundTrips(workbench)) {
      const expected = fillTemplate(roundTrip.template, roundTrip.placeholderValues);
      const engineText = await roundTrip.engineText();
      if (!holdsWholeLines(engineText, expected)) mismatches.push({ expected, engineText });
    }

    expect(mismatches).toEqual([]);
  });
});
