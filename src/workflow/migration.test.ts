import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, mungePath } from "../corpus";
import { serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";
import { WORKFLOW_PHASE_DIR, MigrationError, planMigration, applyMigration, specSlug } from "./migration";

const SPEC_SLUG = "sample-spec";

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
    knowledge: [],
  };
}

function workflowFile(corpusDir: string, id: string, slug: string = SPEC_SLUG): string {
  return join(corpusDir, WORKFLOW_PHASE_DIR, slug, `phase-${id}.md`);
}

const relativeOf = (id: string, slug: string = SPEC_SLUG): string =>
  join(WORKFLOW_PHASE_DIR, slug, `phase-${id}.md`);

describe("specSlug", () => {
  test("strips the directory and extension and lowercases", () => {
    expect(specSlug("/home/u/docs/Recall-Origin.md")).toBe("recall-origin");
  });

  test("maps disallowed characters to dashes, collapsing runs and trimming edges", () => {
    expect(specSlug("!! V2 Spec (final)!!.md")).toBe("v2-spec-final");
  });

  test("throws when the name sanitizes to nothing", () => {
    expect(() => specSlug("/tmp/___.md")).toThrow(MigrationError);
  });
});

describe("planMigration", () => {
  test("classifies a new phase as create under the spec-slug subfolder and writes nothing", () => {
    const corpusDir = tempDir("mneme-mig-plan-");
    const plan = planMigration([phase("alpha")], corpusDir, SPEC_SLUG);
    expect(plan.writes.map((write) => [write.relativePath, write.action])).toEqual([[relativeOf("alpha"), "create"]]);
    expect(plan.workflowDir).toBe(join(corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG));
    expect(plan.writes[0]!.bytes).toBeGreaterThan(0);
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });

  test("throws MigrationError on duplicate phase ids, writing nothing", () => {
    const corpusDir = tempDir("mneme-mig-dup-");
    expect(() => planMigration([phase("alpha"), phase("alpha")], corpusDir, SPEC_SLUG)).toThrow(MigrationError);
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });

  test("fails closed on an invalid phase id via serialize, writing nothing", () => {
    const corpusDir = tempDir("mneme-mig-badid-");
    const traversal = { ...phase("alpha"), id: "../evil" } as PhaseDocument;
    expect(() => planMigration([traversal], corpusDir, SPEC_SLUG)).toThrow();
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });

  test("fails closed on a slug that is not a safe path component, writing nothing", () => {
    const corpusDir = tempDir("mneme-mig-badslug-");
    expect(() => planMigration([phase("alpha")], corpusDir, "../escape")).toThrow(MigrationError);
    expect(existsSync(join(corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
  });
});

describe("applyMigration", () => {
  test("creates the phase file, keeps every path inside the spec-slug dir, leaves no temp files", () => {
    const corpusDir = tempDir("mneme-mig-apply-");
    const plan = planMigration([phase("alpha"), phase("beta")], corpusDir, SPEC_SLUG);

    const report = applyMigration(plan);

    expect(report.created.sort()).toEqual([relativeOf("alpha"), relativeOf("beta")]);
    const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG);
    for (const write of plan.writes) {
      expect(write.absolutePath.startsWith(workflowDir + "/")).toBe(true);
    }
    expect(readFileSync(workflowFile(corpusDir, "alpha"), "utf8")).toBe(serializePhaseDocument(phase("alpha")));
    expect(readdirSync(workflowDir).some((name) => name.endsWith(".mneme-tmp"))).toBe(false);
  });

  test("the same phase id from two different specs lands in separate subfolders without colliding", () => {
    const corpusDir = tempDir("mneme-mig-collide-");

    const first = applyMigration(planMigration([phase("shared")], corpusDir, "spec-a"));
    const second = applyMigration(planMigration([phase("shared")], corpusDir, "spec-b"));

    expect(first.created).toEqual([relativeOf("shared", "spec-a")]);
    expect(second.created).toEqual([relativeOf("shared", "spec-b")]);
    expect(existsSync(workflowFile(corpusDir, "shared", "spec-a"))).toBe(true);
    expect(existsSync(workflowFile(corpusDir, "shared", "spec-b"))).toBe(true);
  });

  test("a byte-identical re-run skips idempotently and writes nothing new", () => {
    const corpusDir = tempDir("mneme-mig-idem-");
    applyMigration(planMigration([phase("alpha")], corpusDir, SPEC_SLUG));

    const secondPlan = planMigration([phase("alpha")], corpusDir, SPEC_SLUG);
    expect(secondPlan.writes[0]!.action).toBe("identical");
    const report = applyMigration(secondPlan);

    expect(report.created).toEqual([]);
    expect(report.skipped).toEqual([relativeOf("alpha")]);
  });

  test("a divergent existing file is a conflict that refuses apply and never clobbers the human edit", () => {
    const corpusDir = tempDir("mneme-mig-conflict-");
    const workflowDir = join(corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG);
    mkdirSync(workflowDir, { recursive: true });
    const humanEdit = "--- human edit, do not clobber ---\n";
    writeFileSync(workflowFile(corpusDir, "alpha"), humanEdit);

    const plan = planMigration([phase("alpha")], corpusDir, SPEC_SLUG);
    expect(plan.writes[0]!.action).toBe("conflict");
    expect(() => applyMigration(plan)).toThrow(MigrationError);
    expect(readFileSync(workflowFile(corpusDir, "alpha"), "utf8")).toBe(humanEdit);
  });
});

const EM_DASH = String.fromCharCode(0x2014);

// A synthetic multi-phase spec built at runtime for the migrate end-to-end test only. It is
// deliberately unrelated to the project's gitignored docs/V2-SPEC.md so the test runs on a clean
// clone (CI, dogfood in a bare environment) -- reading the live spec made this test pass only on
// machines that happen to carry docs/. The from-spec test was cut over for the same reason; this
// mirrors it. Every phase carries an executable done-when block (Policy A: from-spec requires an
// explicit fenced "**Done when (EXECUTABLE):**" criterion per phase) alongside its prose done-when
// line, which remains the phase-description source. Kept inline per the repo convention that
// fixtures are built at runtime, never read from the tree; the em-dash is composed via EM_DASH so
// this source file stays pure ASCII.
const MIGRATION_SAMPLE_SPEC = [
  "# Gameplan",
  "",
  "A sequential build plan that exists only for the migrate end-to-end test.",
  "",
  `### Phase 1: ingest source ${EM_DASH} read the raw input`,
  "",
  "- [ ] open the input",
  "",
  "**Done when:** the raw input parses.",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/ingest.test.ts",
  "```",
  "the ingest suite is green.",
  "",
  `### Phase 2: normalize records ${EM_DASH} canonical form`,
  "",
  "- [ ] map the fields",
  "",
  "**Done when:** records reach canonical form.",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/normalize.test.ts",
  "```",
  "the normalize suite is green.",
  "",
  `### Phase 3: index store ${EM_DASH} build the searchable index`,
  "",
  "- [ ] write the index",
  "",
  "**Done when:** the index round-trips.",
  "",
  "**Done when (EXECUTABLE):**",
  "```",
  "bun test src/index-store.test.ts",
  "```",
  "the index suite is green.",
  "",
].join("\n");

describe("scripts/migrate.ts end-to-end", () => {
  const scriptPath = join(import.meta.dir, "..", "..", "scripts", "migrate.ts");

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

  test("dry-run writes nothing, --apply lands phase files under the spec slug, and a re-run is idempotent", async () => {
    const tempHome = tempDir("mneme-mig-home-");
    const projectCwd = tempDir("mneme-mig-cwd-");
    const specPath = join(tempDir("mneme-mig-spec-"), "sample-spec.md");
    writeFileSync(specPath, MIGRATION_SAMPLE_SPEC);
    // The three-phase spec lands under its own slug subfolder, not the flat workflow root.
    const workflowDir = join(
      tempHome,
      ".mneme",
      mungePath(canonicalize(projectCwd)),
      WORKFLOW_PHASE_DIR,
      "sample-spec",
    );

    const dry = await runMigrate([specPath], tempHome, projectCwd);
    expect(dry.code).toBe(0);
    expect(existsSync(workflowDir)).toBe(false);
    // Dry-run prints the full absolute destination path so it is copy-pasteable before any write.
    expect(dry.stdout).toContain(join(workflowDir, "phase-ingest-source.md"));

    const applied = await runMigrate([specPath, "--apply"], tempHome, projectCwd);
    expect(applied.code).toBe(0);
    const written = readdirSync(workflowDir).filter((name) => name.endsWith(".md"));
    expect(written.length).toBe(3);
    // --apply prints each created file's absolute path plus, for a multi-phase plan, the whole spec
    // DIRECTORY as the /mneme:dev launch target. The launch line is matched exactly: a substring
    // check would also accept a phase-file path, which carries the directory as a prefix.
    expect(applied.stdout).toContain(join(workflowDir, "phase-ingest-source.md"));
    expect(applied.stdout.split("\n")).toContain(`  /mneme:dev ${workflowDir}`);
    expect(applied.stdout).not.toContain("multi-phase support");

    const reapplied = await runMigrate([specPath, "--apply"], tempHome, projectCwd);
    expect(reapplied.code).toBe(0);
    expect(reapplied.stdout).toContain("wrote 0");
  }, 30_000);

  test("a spec whose done-when carries a shell construction fails the whole migration before any write", async () => {
    const tempHome = tempDir("mneme-mig-shell-home-");
    const projectCwd = tempDir("mneme-mig-shell-cwd-");
    const specPath = join(tempDir("mneme-mig-shell-spec-"), "shell-spec.md");
    writeFileSync(specPath, MIGRATION_SAMPLE_SPEC.replace(
      "bun test src/normalize.test.ts",
      "bun run typecheck && bun test src/normalize.test.ts",
    ));

    const applied = await runMigrate([specPath, "--apply"], tempHome, projectCwd);

    expect(applied.code).toBe(2);
    expect(existsSync(join(tempHome, ".mneme", mungePath(canonicalize(projectCwd)), WORKFLOW_PHASE_DIR))).toBe(false);
  }, 30_000);
});
