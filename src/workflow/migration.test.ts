import { test, expect, describe, afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, corpusPaths, mungePath } from "../corpus";
import type { Corpus } from "../corpus";
import { CorpusGitError } from "../corpus-git";
import { initRepo, runGit } from "../git";
import { serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";
import {
  SPEC_ARCHIVE_DIR,
  WORKFLOW_PHASE_DIR,
  MigrationError,
  planMigration,
  applyMigration,
  specSlug,
} from "./migration";

// These tests spawn real git repositories plus end-to-end bun subprocesses; under machine load the
// slowest cases exceed bun's 5s default per-test timeout and fail the suite spuriously.
setDefaultTimeout(30_000);

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

function archiveFile(corpusDir: string, slug: string = SPEC_SLUG): string {
  return join(corpusDir, SPEC_ARCHIVE_DIR, `${slug}.md`);
}

// A corpus whose directory is a real git repository, as resolveCorpus guarantees in production.
async function gitCorpus(prefix: string): Promise<Corpus> {
  const corpusDir = tempDir(prefix);
  await initRepo(corpusDir);
  return { canonicalRoot: tempDir(`${prefix}root-`), ...corpusPaths(corpusDir) };
}

// A corpus over a plain directory with NO git repository — the git-failure fixture.
function bareCorpus(prefix: string): Corpus {
  return { canonicalRoot: tempDir(`${prefix}root-`), ...corpusPaths(tempDir(prefix)) };
}

function specFile(prefix: string, content: string | Buffer): string {
  const specPath = join(tempDir(prefix), "source-spec.md");
  writeFileSync(specPath, content);
  return specPath;
}

async function commitCount(corpusDir: string): Promise<number> {
  const counted = await runGit(corpusDir, ["rev-list", "--count", "HEAD"]);
  return counted.exitCode === 0 ? Number(counted.stdout.trim()) : 0;
}

async function lastCommit(corpusDir: string): Promise<{ subject: string; files: string[] }> {
  const shown = await runGit(corpusDir, ["show", "--name-only", "--format=%s", "HEAD"]);
  const lines = shown.stdout.trim().split("\n").filter((line) => line !== "");
  return { subject: lines[0] ?? "", files: lines.slice(1) };
}

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
  test("creates the phase file, keeps every path inside the spec-slug dir, leaves no temp files", async () => {
    const corpus = await gitCorpus("mneme-mig-apply-");
    const specPath = specFile("mneme-mig-apply-spec-", "# source\n");
    const plan = planMigration([phase("alpha"), phase("beta")], corpus.corpusDir, SPEC_SLUG);

    const report = await applyMigration(plan, { specPath, corpus });

    expect(report.created.sort()).toEqual([relativeOf("alpha"), relativeOf("beta")]);
    const workflowDir = join(corpus.corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG);
    for (const write of plan.writes) {
      expect(write.absolutePath.startsWith(workflowDir + "/")).toBe(true);
    }
    expect(readFileSync(workflowFile(corpus.corpusDir, "alpha"), "utf8")).toBe(serializePhaseDocument(phase("alpha")));
    expect(readdirSync(workflowDir).some((name) => name.endsWith(".mneme-tmp"))).toBe(false);
  });

  test("the same phase id from two different specs lands in separate subfolders without colliding", async () => {
    const corpus = await gitCorpus("mneme-mig-collide-");
    const specPath = specFile("mneme-mig-collide-spec-", "# source\n");

    const first = await applyMigration(planMigration([phase("shared")], corpus.corpusDir, "spec-a"), { specPath, corpus });
    const second = await applyMigration(planMigration([phase("shared")], corpus.corpusDir, "spec-b"), { specPath, corpus });

    expect(first.created).toEqual([relativeOf("shared", "spec-a")]);
    expect(second.created).toEqual([relativeOf("shared", "spec-b")]);
    expect(existsSync(workflowFile(corpus.corpusDir, "shared", "spec-a"))).toBe(true);
    expect(existsSync(workflowFile(corpus.corpusDir, "shared", "spec-b"))).toBe(true);
    expect(existsSync(archiveFile(corpus.corpusDir, "spec-a"))).toBe(true);
    expect(existsSync(archiveFile(corpus.corpusDir, "spec-b"))).toBe(true);
  });

  test("a byte-identical re-run skips idempotently and writes nothing new", async () => {
    const corpus = await gitCorpus("mneme-mig-idem-");
    const specPath = specFile("mneme-mig-idem-spec-", "# source\n");
    await applyMigration(planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG), { specPath, corpus });

    const secondPlan = planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG);
    expect(secondPlan.writes[0]!.action).toBe("identical");
    const report = await applyMigration(secondPlan, { specPath, corpus });

    expect(report.created).toEqual([]);
    expect(report.skipped).toEqual([relativeOf("alpha")]);
  });

  test("a divergent existing file is a conflict that refuses apply and never clobbers the human edit", async () => {
    const corpus = await gitCorpus("mneme-mig-conflict-");
    const specPath = specFile("mneme-mig-conflict-spec-", "# source\n");
    const workflowDir = join(corpus.corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG);
    mkdirSync(workflowDir, { recursive: true });
    const humanEdit = "--- human edit, do not clobber ---\n";
    writeFileSync(workflowFile(corpus.corpusDir, "alpha"), humanEdit);

    const plan = planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG);
    expect(plan.writes[0]!.action).toBe("conflict");
    await expect(applyMigration(plan, { specPath, corpus })).rejects.toThrow(MigrationError);
    expect(readFileSync(workflowFile(corpus.corpusDir, "alpha"), "utf8")).toBe(humanEdit);
  });
});

describe("applyMigration spec archive and commit", () => {
  test("apply archives the spec byte-for-byte and commits phases plus archive in ONE commit", async () => {
    const corpus = await gitCorpus("mneme-mig-arch-");
    const specBytes = Buffer.from(`# spec ${EM_DASH} source\r\nsecond line, no trailing newline`, "utf8");
    const specPath = specFile("mneme-mig-arch-spec-", specBytes);
    const plan = planMigration([phase("alpha"), phase("beta")], corpus.corpusDir, SPEC_SLUG);

    const report = await applyMigration(plan, { specPath, corpus });

    expect(readFileSync(archiveFile(corpus.corpusDir)).equals(specBytes)).toBe(true);
    expect(await commitCount(corpus.corpusDir)).toBe(1);
    const committed = await lastCommit(corpus.corpusDir);
    expect(committed.subject).toBe(`Migrate ${SPEC_SLUG}: 2 phases`);
    expect(committed.files.sort()).toEqual([
      join(SPEC_ARCHIVE_DIR, `${SPEC_SLUG}.md`),
      relativeOf("alpha"),
      relativeOf("beta"),
    ]);
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a byte-identical re-apply mints no new commit and returns the same sha", async () => {
    const corpus = await gitCorpus("mneme-mig-samesha-");
    const specPath = specFile("mneme-mig-samesha-spec-", "# stable source\n");
    const first = await applyMigration(planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG), { specPath, corpus });

    const second = await applyMigration(planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG), { specPath, corpus });

    expect(second.commit).toBe(first.commit);
    expect(await commitCount(corpus.corpusDir)).toBe(1);
  });

  test("a changed spec re-apply overwrites the archive and the new commit carries its diff", async () => {
    const corpus = await gitCorpus("mneme-mig-respec-");
    const specPath = specFile("mneme-mig-respec-spec-", "# source v1\n");
    const first = await applyMigration(planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG), { specPath, corpus });

    writeFileSync(specPath, "# source v1\nan appended clarification\n");
    const second = await applyMigration(planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG), { specPath, corpus });

    expect(second.commit).not.toBe(first.commit);
    expect(await commitCount(corpus.corpusDir)).toBe(2);
    expect(readFileSync(archiveFile(corpus.corpusDir), "utf8")).toBe("# source v1\nan appended clarification\n");
    const committed = await lastCommit(corpus.corpusDir);
    expect(committed.files).toEqual([join(SPEC_ARCHIVE_DIR, `${SPEC_SLUG}.md`)]);
  });

  test("planMigration alone touches neither the archive nor git — the dry-run stays clean", async () => {
    const corpus = await gitCorpus("mneme-mig-dryclean-");
    planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG);

    expect(existsSync(join(corpus.corpusDir, WORKFLOW_PHASE_DIR))).toBe(false);
    expect(existsSync(join(corpus.corpusDir, SPEC_ARCHIVE_DIR))).toBe(false);
    expect(await commitCount(corpus.corpusDir)).toBe(0);
  });

  test("a conflict refuses apply before anything lands: no phases, no archive, no commit", async () => {
    const corpus = await gitCorpus("mneme-mig-confclean-");
    const specPath = specFile("mneme-mig-confclean-spec-", "# source\n");
    const workflowDir = join(corpus.corpusDir, WORKFLOW_PHASE_DIR, SPEC_SLUG);
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(workflowFile(corpus.corpusDir, "alpha"), "--- human edit ---\n");

    const plan = planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG);
    await expect(applyMigration(plan, { specPath, corpus })).rejects.toThrow(MigrationError);

    expect(existsSync(join(corpus.corpusDir, SPEC_ARCHIVE_DIR))).toBe(false);
    expect(await commitCount(corpus.corpusDir)).toBe(0);
  });

  test("a git failure leaves the written files on disk and surfaces a clear error", async () => {
    const corpus = bareCorpus("mneme-mig-gitfail-");
    const specPath = specFile("mneme-mig-gitfail-spec-", "# source\n");
    const plan = planMigration([phase("alpha")], corpus.corpusDir, SPEC_SLUG);

    await expect(applyMigration(plan, { specPath, corpus })).rejects.toThrow(CorpusGitError);

    expect(existsSync(workflowFile(corpus.corpusDir, "alpha"))).toBe(true);
    expect(existsSync(archiveFile(corpus.corpusDir))).toBe(true);
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
    // The applied spec is archived byte-for-byte into the corpus beside the phases it generated.
    const archivedSpec = join(tempHome, ".mneme", mungePath(canonicalize(projectCwd)), SPEC_ARCHIVE_DIR, "sample-spec.md");
    expect(readFileSync(archivedSpec, "utf8")).toBe(MIGRATION_SAMPLE_SPEC);
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
