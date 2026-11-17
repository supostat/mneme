import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusPaths } from "../corpus";
import type { Corpus } from "../corpus";
import { initRepo } from "../git";
import { phaseDocumentsFromSpec } from "./from-spec";
import { MigratedSpecError, migratedSpecSlugs, readMigratedSpec } from "./migrated-spec";
import { SPEC_ARCHIVE_DIR, WORKFLOW_PHASE_DIR, applyMigration, planMigration } from "./migration";
import { serializePhaseDocument } from "./phase-document";
import type { PhaseDocument } from "./phase-document";

// The migrated spec is read back from what migrate really wrote: the two-phase case runs the real
// spec parser, the real planMigration and the real applyMigration into a git corpus, and the refusal
// cases lay files out by hand exactly where migrate would put them.

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

async function gitCorpus(): Promise<Corpus> {
  const corpusDir = tempDir("mneme-migrated-spec-corpus-");
  await initRepo(corpusDir);
  return { canonicalRoot: tempDir("mneme-migrated-spec-root-"), ...corpusPaths(corpusDir) };
}

// A two-phase spec whose Knowledge carries a continuation line, so the folded bullet is observable.
function twoPhaseSpec(knowledgeLead: string): string {
  return [
    "# Knowledge",
    "",
    `- **Lead.** ${knowledgeLead}`,
    "  continued on the next line.",
    "- **Second.** Another rule.",
    "",
    "# Gameplan",
    "",
    `### Phase 1: first ${EM_DASH} the first phase`,
    "",
    "- [ ] do the first thing",
    "",
    "**Done when (EXECUTABLE):**",
    "```",
    "bun test src/first.test.ts",
    "```",
    "first suite is green.",
    "",
    `### Phase 2: second ${EM_DASH} the second phase (order-only после фазы 1)`,
    "",
    "- [ ] do the second thing",
    "",
    "**Done when (EXECUTABLE):**",
    "```",
    "bun test src/second.test.ts",
    "```",
    "second suite is green.",
    "",
  ].join("\n");
}

async function migrate(corpus: Corpus, slug: string, specText: string): Promise<PhaseDocument[]> {
  const specPath = join(tempDir("mneme-migrated-spec-src-"), `${slug}.md`);
  writeFileSync(specPath, specText);
  const documents = phaseDocumentsFromSpec(specText);
  await applyMigration(planMigration(documents, corpus.corpusDir, slug), { specPath, corpus });
  return documents;
}

function phaseDocument(id: string, knowledge: string[] = []): PhaseDocument {
  return {
    id,
    deps: [],
    agentRole: "coder",
    description: `phase ${id}`,
    tasks: ["do the work"],
    doneWhen: [{ kind: "executable", description: "green", command: "bun test", timeoutSeconds: null }],
    knowledge,
  };
}

// Lays out a migrated folder by hand: the phase files where migrate writes them, the archive optional.
function layOut(corpusDir: string, slug: string, documents: PhaseDocument[], archive: string | null): void {
  const specDir = join(corpusDir, WORKFLOW_PHASE_DIR, slug);
  mkdirSync(specDir, { recursive: true });
  for (const document of documents) {
    writeFileSync(join(specDir, `phase-${document.id}.md`), serializePhaseDocument(document));
  }
  if (archive === null) return;
  mkdirSync(join(corpusDir, SPEC_ARCHIVE_DIR), { recursive: true });
  writeFileSync(join(corpusDir, SPEC_ARCHIVE_DIR, `${slug}.md`), archive);
}

function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(MigratedSpecError);
    return (error as Error).message;
  }
  throw new Error("the read was expected to refuse");
}

describe("readMigratedSpec over a real migration", () => {
  test("a two-phase folder gives both phases with their deps and the archive's Knowledge as from-spec folds it", async () => {
    const corpus = await gitCorpus();
    const documents = await migrate(corpus, "two-phase", twoPhaseSpec("Read the archive."));

    const spec = readMigratedSpec(corpus.corpusDir, "two-phase");

    expect(spec.slug).toBe("two-phase");
    expect(spec.documents.map((document) => [document.id, document.deps])).toEqual([
      ["first", []],
      ["second", ["first"]],
    ]);
    expect(spec.documents).toEqual(documents);
    expect(spec.knowledge).toEqual([
      "**Lead.** Read the archive. continued on the next line.",
      "**Second.** Another rule.",
    ]);
    expect(migratedSpecSlugs(corpus.corpusDir)).toEqual([{ slug: "two-phase", phaseCount: 2 }]);
  });
});

describe("migratedSpecSlugs", () => {
  test("lists folders holding phase files, by slug, with their phase counts; a folder without one is not a spec", () => {
    const corpusDir = tempDir("mneme-migrated-spec-list-");
    layOut(corpusDir, "beta", [phaseDocument("only")], null);
    layOut(corpusDir, "alpha", [phaseDocument("one"), phaseDocument("two")], null);
    mkdirSync(join(corpusDir, WORKFLOW_PHASE_DIR, "stray"), { recursive: true });
    writeFileSync(join(corpusDir, WORKFLOW_PHASE_DIR, "stray", "notes.txt"), "not a phase\n");

    expect(migratedSpecSlugs(corpusDir)).toEqual([
      { slug: "alpha", phaseCount: 2 },
      { slug: "beta", phaseCount: 1 },
    ]);
  });

  test("a corpus without a workflow folder has no migrated spec", () => {
    expect(migratedSpecSlugs(tempDir("mneme-migrated-spec-empty-"))).toEqual([]);
  });
});

describe("readMigratedSpec refusals and the archive's place", () => {
  test("a slug outside the grammar is refused before a path is built, even where a matching folder exists", () => {
    const corpusDir = tempDir("mneme-migrated-spec-grammar-");
    layOut(join(corpusDir, "nested"), "x", [phaseDocument("escaped")], null);
    layOut(corpusDir, "Spec_A", [phaseDocument("upper")], null);

    expect(refusalOf(() => readMigratedSpec(join(corpusDir, "nested", WORKFLOW_PHASE_DIR), "../x"))).toBe(
      'spec slug "../x" is not a slug: lowercase letters and digits separated by single dashes',
    );
    expect(refusalOf(() => readMigratedSpec(corpusDir, "Spec_A"))).toBe(
      'spec slug "Spec_A" is not a slug: lowercase letters and digits separated by single dashes',
    );
  });

  test("an unknown slug is refused with the migrated slugs in order, or with none migrated", () => {
    const corpusDir = tempDir("mneme-migrated-spec-unknown-");
    layOut(corpusDir, "beta", [phaseDocument("only")], null);
    layOut(corpusDir, "alpha", [phaseDocument("only")], null);

    expect(refusalOf(() => readMigratedSpec(corpusDir, "gamma"))).toBe(
      'no migrated spec "gamma" in this corpus; migrated specs: alpha, beta',
    );
    expect(refusalOf(() => readMigratedSpec(tempDir("mneme-migrated-spec-none-"), "gamma"))).toBe(
      'no migrated spec "gamma" in this corpus; no spec is migrated',
    );
  });

  test("a folder holding no phase file is not read: it is refused like an unknown slug", () => {
    const corpusDir = tempDir("mneme-migrated-spec-stray-");
    mkdirSync(join(corpusDir, WORKFLOW_PHASE_DIR, "stray"), { recursive: true });
    writeFileSync(join(corpusDir, WORKFLOW_PHASE_DIR, "stray", "notes.txt"), "not a phase\n");

    expect(refusalOf(() => readMigratedSpec(corpusDir, "stray"))).toBe(
      'no migrated spec "stray" in this corpus; no spec is migrated',
    );
  });

  test("a phase file that does not parse is refused by its name", () => {
    const corpusDir = tempDir("mneme-migrated-spec-broken-");
    layOut(corpusDir, "broken", [phaseDocument("fine")], null);
    writeFileSync(join(corpusDir, WORKFLOW_PHASE_DIR, "broken", "phase-bad.md"), "no frontmatter here\n");

    expect(refusalOf(() => readMigratedSpec(corpusDir, "broken"))).toStartWith(
      `phase file ${join(WORKFLOW_PHASE_DIR, "broken", "phase-bad.md")} does not parse: `,
    );
  });

  test("without an archive the phases are read and the Knowledge is null, not empty", () => {
    const corpusDir = tempDir("mneme-migrated-spec-no-archive-");
    layOut(corpusDir, "bare", [phaseDocument("only", ["phase-file knowledge"])], null);

    const spec = readMigratedSpec(corpusDir, "bare");

    expect(spec.documents.map((document) => document.id)).toEqual(["only"]);
    expect(spec.knowledge).toBeNull();
  });

  test("an archive whose Knowledge does not parse is refused by the archive's name and the parser's reason", () => {
    const corpusDir = tempDir("mneme-migrated-spec-bad-archive-");
    layOut(corpusDir, "bad-archive", [phaseDocument("only")], "# Knowledge\n\n- a bullet\nan unindented stray line\n");

    expect(refusalOf(() => readMigratedSpec(corpusDir, "bad-archive"))).toStartWith(
      `spec archive ${join(SPEC_ARCHIVE_DIR, "bad-archive.md")} has a Knowledge section that does not parse: ` +
        "the # Knowledge section carries a line no rule covers",
    );
  });

  test("the Knowledge comes from the archive, not from a hand-edited phase file", () => {
    const corpusDir = tempDir("mneme-migrated-spec-edited-");
    layOut(corpusDir, "edited", [phaseDocument("only", ["edited by hand in the phase file"])], "# Knowledge\n\n- from the archive\n");

    expect(readMigratedSpec(corpusDir, "edited").knowledge).toEqual(["from the archive"]);
  });
});
