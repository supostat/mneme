import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, mungePath } from "../corpus";
import { serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";
import { WORKFLOW_PHASE_DIR, MigrationError, planMigration, applyMigration } from "./migration";

const temporaryDirectories: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function phase(id: string, tasks: string[] = ["do the work"]): PhaseDocument {
  return {
    id,
    deps: [],
    agentRole: "coder",
    description: `phase ${id}`,
    tasks,
    doneWhen: [{ kind: "executable", description: "verified", command: "bun test" }],
  };
}

function workflowFile(corpusDir: string, id: string): string {
  return join(corpusDir, WORKFLOW_PHASE_DIR, `phase-${id}.md`);
}

const relativeOf = (id: string): string => join(WORKFLOW_PHASE_DIR, `phase-${id}.md`);

describe("planMigration", () => {
  test("classifies a new phase as create and writes nothing", () => {
    const corpusDir = tempDir("mneme-mig-plan-");
    const plan = planMigration([phase("alpha")], corpusDir);
    expect(plan.writes.map((write) => [write.relativePath, write.action])).toEqual([[relativeOf("alpha"), "create"]]);
    expect(plan.writes[0]!.bytes).toBeGreaterThan(0);
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });

  test("throws MigrationError on duplicate phase ids, writing nothing", () => {
    const corpusDir = tempDir("mneme-mig-dup-");
    expect(() => planMigration([phase("alpha"), phase("alpha")], corpusDir)).toThrow(MigrationError);
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });

  test("fails closed on an invalid phase id via serialize, writing nothing", () => {
    const corpusDir = tempDir("mneme-mig-badid-");
    const traversal = { ...phase("alpha"), id: "../evil" } as PhaseDocument;
    expect(() => planMigration([traversal], corpusDir)).toThrow();
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });
});

describe("applyMigration", () => {
  test("creates the phase file, keeps every path inside the workflow dir, leaves no temp files", () => {
    const corpusDir = tempDir("mneme-mig-apply-");
    const plan = planMigration([phase("alpha"), phase("beta")], corpusDir);

    const report = applyMigration(plan);

    expect(report.created.sort()).toEqual([relativeOf("alpha"), relativeOf("beta")]);
    const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR);
    for (const write of plan.writes) {
      expect(write.absolutePath.startsWith(workflowDir + "/")).toBe(true);
    }
    expect(readFileSync(workflowFile(corpusDir, "alpha"), "utf8")).toBe(serializePhaseDocument(phase("alpha")));
    expect(readdirSync(workflowDir).some((name) => name.endsWith(".mneme-tmp"))).toBe(false);
  });

  test("a byte-identical re-run skips idempotently and writes nothing new", () => {
    const corpusDir = tempDir("mneme-mig-idem-");
    applyMigration(planMigration([phase("alpha")], corpusDir));

    const secondPlan = planMigration([phase("alpha")], corpusDir);
    expect(secondPlan.writes[0]!.action).toBe("identical");
    const report = applyMigration(secondPlan);

    expect(report.created).toEqual([]);
    expect(report.skipped).toEqual([relativeOf("alpha")]);
  });

  test("a divergent existing file is a conflict that refuses apply and never clobbers the human edit", () => {
    const corpusDir = tempDir("mneme-mig-conflict-");
    const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR);
    mkdirSync(workflowDir, { recursive: true });
    const humanEdit = "--- human edit, do not clobber ---\n";
    writeFileSync(workflowFile(corpusDir, "alpha"), humanEdit);

    const plan = planMigration([phase("alpha")], corpusDir);
    expect(plan.writes[0]!.action).toBe("conflict");
    expect(() => applyMigration(plan)).toThrow(MigrationError);
    expect(readFileSync(workflowFile(corpusDir, "alpha"), "utf8")).toBe(humanEdit);
  });
});

describe("scripts/migrate.ts end-to-end", () => {
  const scriptPath = join(import.meta.dir, "..", "..", "scripts", "migrate.ts");
  const specPath = join(import.meta.dir, "..", "..", "docs", "V2-SPEC.md");

  async function runMigrate(
    args: string[],
    tempHome: string,
    projectCwd: string,
  ): Promise<{ code: number; stdout: string }> {
    const child = Bun.spawn({
      cmd: ["bun", scriptPath, ...args],
      cwd: projectCwd,
      env: { ...process.env, HOME: tempHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout };
  }

  test("dry-run writes nothing, --apply lands phase files, and a re-run is idempotent", async () => {
    const tempHome = tempDir("mneme-mig-home-");
    const projectCwd = tempDir("mneme-mig-cwd-");
    const workflowDir = join(tempHome, ".mneme", mungePath(canonicalize(projectCwd)), WORKFLOW_PHASE_DIR);

    const dry = await runMigrate([specPath], tempHome, projectCwd);
    expect(dry.code).toBe(0);
    expect(existsSync(workflowDir)).toBe(false);

    const applied = await runMigrate([specPath, "--apply"], tempHome, projectCwd);
    expect(applied.code).toBe(0);
    const written = readdirSync(workflowDir).filter((name) => name.endsWith(".md"));
    expect(written.length).toBeGreaterThan(0);

    const reapplied = await runMigrate([specPath, "--apply"], tempHome, projectCwd);
    expect(reapplied.code).toBe(0);
    expect(reapplied.stdout).toContain("wrote 0");
  }, 30_000);
});
