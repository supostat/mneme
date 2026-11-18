import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { resolveCorpus } from "../corpus";
import { EMBEDDING_MODEL } from "../embeddings";
import type { EmbeddingsClient } from "../embeddings";
import { EventWriter } from "../events";
import { initRepo, runGit } from "../git";
import type { StagingDeps } from "../staging";
import { phaseDocumentsFromSpec } from "./from-spec";
import { workflowStartTool } from "./mcp-tools";
import { applyMigration, planMigration } from "./migration";
import { workflowSpecTool } from "./spec-tool";

// The edge from the start to the read, with nothing stood in: a real project repository, a real
// corpus, the real spec parser and applyMigration, the real workflowStartTool reading the migrated
// folder by slug and stamping the project HEAD, and workflow_spec reading that run back from the
// event log the start wrote. Nothing here calls an embedder: a start does not embed.

setDefaultTimeout(30_000);

const EM_DASH = String.fromCharCode(0x2014);
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const SPEC_TEXT = [
  "# Knowledge",
  "",
  "- **Rule.** read the archive",
  "  across two lines.",
  "",
  "# Gameplan",
  "",
  `### Phase 1: parse input ${EM_DASH} read the raw text`,
  "",
  "- [ ] read the input",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/parse.test.ts",
  "```",
  "the parse suite is green.",
  "",
  `### Phase 2: store records ${EM_DASH} persist them (order-only после фазы 1)`,
  "",
  "- [ ] write the records",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/store.test.ts",
  "```",
  "the store suite is green.",
  "",
].join("\n");

const UNUSED_EMBEDDER: EmbeddingsClient = {
  model: EMBEDDING_MODEL,
  embed: async () => ({ available: false, embeddings: [], retries: 0 }),
};

describe("workflowStartTool by spec_slug, read back by workflow_spec", () => {
  test("the run started from the migrated folder answers its slug, the project HEAD, the archive's Knowledge and its phases", async () => {
    const projectRoot = tempDir("mneme-spec-real-proj-");
    await initRepo(projectRoot);
    writeFileSync(join(projectRoot, "a.ts"), "content\n");
    await runGit(projectRoot, ["add", "."]);
    await runGit(projectRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    const projectHead = (await runGit(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const corpus = await resolveCorpus(projectRoot, { corpusHome: tempDir("mneme-spec-real-home-") });
    const specPath = join(projectRoot, "sample-spec.md");
    writeFileSync(specPath, SPEC_TEXT);
    await applyMigration(planMigration(phaseDocumentsFromSpec(SPEC_TEXT), corpus.corpusDir, "sample-spec"), {
      specPath,
      corpus,
    });
    let counter = 0;
    const deps: StagingDeps = {
      corpus,
      projectRoot,
      config: defaultConfig(),
      clock: () => new Date("2026-11-17T10:00:00.000Z"),
      idFactory: () => `01ARZ3NDEKTSV4RRFFQ69G5FB${counter++}`,
      embeddings: UNUSED_EMBEDDER,
      eventWriter: new EventWriter(corpus.eventsDir, { sessionId: "s-spec-real", mnemeVersion: "0.1.0", clock: () => new Date("2026-11-17T10:00:00.000Z") }),
    };

    const started = await workflowStartTool(deps, {
      spec_slug: "sample-spec",
      steps: [{ id: "implement", max_attempts: 2, on_fail: { action: "escalate" } }],
      max_iterations: 20,
    });
    const startText = (started.content as Array<{ text: string }>)[0]!.text;
    const runId = /Started workflow run (\S+) on branch/.exec(startText)?.[1];
    if (runId === undefined) throw new Error(`the start reported no run id:\n${startText}`);
    const branch = (await runGit(projectRoot, ["branch", "--show-current"])).stdout.trim();

    const read = workflowSpecTool({ corpus }, { run_id: runId });

    expect((read.content as Array<{ text: string }>)[0]!.text.split("\n")).toEqual([
      `Spec of run ${runId} on branch "${branch}". Nothing was written: no event, no file, no stale mark.`,
      `spec sample-spec · base commit ${projectHead}`,
      "knowledge:",
      "- **Rule.** read the archive across two lines.",
      "phase parse-input · deps none",
      "- executable: bun test src/parse.test.ts — the parse suite is green.",
      "phase store-records · deps parse-input",
      "- executable: bun test src/store.test.ts — the store suite is green.",
    ]);
  });
});
