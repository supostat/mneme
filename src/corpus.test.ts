import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, loadConfig } from "./config";
import { resolveCorpus, corpusDirFor, canonicalize, mungePath, CorpusError } from "./corpus";
import { isRepo, runGit } from "./git";

const MANIFEST_FILENAME = "manifest.json";
const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "mneme-project-"));
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "mneme-home-"));
}

describe("resolveCorpus first initialization", () => {
  test("creates corpus directory, subdirectories, manifest, git repo and gitignore", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();

    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });

    expect(corpus.canonicalRoot).toBe(canonicalize(projectRoot));
    expect(corpus.corpusDir).toBe(join(corpusHome, mungePath(canonicalize(projectRoot))));

    for (const directory of [
      corpus.corpusDir,
      corpus.notesDir,
      corpus.stagingDir,
      corpus.archiveDir,
      corpus.eventsDir,
    ]) {
      expect(existsSync(directory)).toBe(true);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }

    const manifest = JSON.parse(readFileSync(corpus.manifestPath, "utf8"));
    expect(manifest.path).toBe(canonicalize(projectRoot));
    expect(manifest.format_version).toBe(3);
    expect("embedding_model" in manifest).toBe(false);
    expect("name" in manifest).toBe(false);
    expect(typeof manifest.created).toBe("string");

    expect(await isRepo(corpus.corpusDir)).toBe(true);
    expect(readFileSync(join(corpus.corpusDir, ".gitignore"), "utf8")).toBe(
      "index.db\nevents/\nstaging/\n*.dedup.json\n",
    );

    expect(corpus.indexPath).toBe(join(corpus.corpusDir, "index.db"));
  });

  test("is idempotent: a second call does not rewrite the manifest", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    let tick = 0;
    const advancingClock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

    const first = await resolveCorpus(projectRoot, { corpusHome, clock: advancingClock });
    const createdBefore = JSON.parse(readFileSync(first.manifestPath, "utf8")).created;
    const second = await resolveCorpus(projectRoot, { corpusHome, clock: advancingClock });
    const createdAfter = JSON.parse(readFileSync(second.manifestPath, "utf8")).created;

    expect(createdAfter).toBe(createdBefore);
  });

  test("a repeated call preserves an existing repo, its commits and files", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();

    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
    const trackedFile = join(corpus.corpusDir, "kept.md");
    writeFileSync(trackedFile, "keep me\n");
    expect((await runGit(corpus.corpusDir, ["add", "kept.md"])).exitCode).toBe(0);
    const commit = await runGit(corpus.corpusDir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add kept note",
    ]);
    expect(commit.exitCode).toBe(0);
    const headBefore = (await runGit(corpus.corpusDir, ["rev-parse", "HEAD"])).stdout.trim();

    await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });

    expect(await isRepo(corpus.corpusDir)).toBe(true);
    expect(existsSync(trackedFile)).toBe(true);
    const headAfter = await runGit(corpus.corpusDir, ["rev-parse", "HEAD"]);
    expect(headAfter.exitCode).toBe(0);
    expect(headAfter.stdout.trim()).toBe(headBefore);
    const reflog = await runGit(corpus.corpusDir, ["reflog"]);
    expect(reflog.stdout).toContain("add kept note");
    const log = await runGit(corpus.corpusDir, ["log", "--oneline"]);
    expect(log.stdout).toContain("add kept note");
  });
});

describe("resolveCorpus fail-closed error paths", () => {
  test("munging collision between a/b and a-b throws CorpusError", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mneme-collision-"));
    mkdirSync(join(parent, "a", "b"), { recursive: true });
    mkdirSync(join(parent, "a-b"));
    const corpusHome = tempHome();

    await resolveCorpus(join(parent, "a", "b"), { corpusHome, clock: fixedClock });

    expect(mungePath(canonicalize(join(parent, "a", "b")))).toBe(
      mungePath(canonicalize(join(parent, "a-b"))),
    );
    await expect(
      resolveCorpus(join(parent, "a-b"), { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("existing corpus directory without a manifest throws CorpusError", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, mungePath(canonicalize(projectRoot)));
    mkdirSync(corpusDir, { recursive: true });

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("corrupt manifest throws CorpusError", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, mungePath(canonicalize(projectRoot)));
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(join(corpusDir, MANIFEST_FILENAME), "{ this is not valid json");

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("unknown manifest format_version throws CorpusError", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, mungePath(canonicalize(projectRoot)));
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      join(corpusDir, MANIFEST_FILENAME),
      JSON.stringify({
        path: canonicalize(projectRoot),
        created: "2026-07-06T10:00:00.000Z",
        format_version: 999,
        embedding_model: null,
      }),
    );

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });
});

describe("readManifest field validation via resolveCorpus", () => {
  function corpusWithManifest(manifestBody: string): {
    projectRoot: string;
    corpusHome: string;
  } {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, mungePath(canonicalize(projectRoot)));
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(join(corpusDir, MANIFEST_FILENAME), manifestBody);
    return { projectRoot, corpusHome };
  }

  test("missing or non-string path throws CorpusError", async () => {
    const { projectRoot, corpusHome } = corpusWithManifest(
      JSON.stringify({
        created: "2026-07-06T10:00:00.000Z",
        format_version: 1,
        embedding_model: null,
      }),
    );

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("missing or non-string created throws CorpusError", async () => {
    const { projectRoot, corpusHome } = corpusWithManifest(
      JSON.stringify({
        path: "/some/project",
        format_version: 1,
        embedding_model: null,
      }),
    );

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("array manifest (missing path) throws CorpusError", async () => {
    const { projectRoot, corpusHome } = corpusWithManifest("[]");

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("a manifest that is a JSON primitive, not an object, throws CorpusError", async () => {
    const { projectRoot, corpusHome } = corpusWithManifest("42");

    await expect(
      resolveCorpus(projectRoot, { corpusHome, clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });
});

describe("format_version migration", () => {
  function writeLegacyV1Manifest(created: string): { projectRoot: string; corpusHome: string } {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, mungePath(canonicalize(projectRoot)));
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      join(corpusDir, MANIFEST_FILENAME),
      JSON.stringify({
        path: canonicalize(projectRoot),
        created,
        format_version: 1,
        embedding_model: null,
      }),
    );
    return { projectRoot, corpusHome };
  }

  function writeLegacyV2Manifest(created: string): { projectRoot: string; corpusHome: string } {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, mungePath(canonicalize(projectRoot)));
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      join(corpusDir, MANIFEST_FILENAME),
      JSON.stringify({ path: canonicalize(projectRoot), created, format_version: 2 }),
    );
    return { projectRoot, corpusHome };
  }

  test("a v1 manifest reaches v3 in a single pass, dropping embedding_model", async () => {
    const created = "2026-05-01T00:00:00.000Z";
    const { projectRoot, corpusHome } = writeLegacyV1Manifest(created);

    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });

    const manifest = JSON.parse(readFileSync(corpus.manifestPath, "utf8"));
    expect(manifest.format_version).toBe(3);
    expect("embedding_model" in manifest).toBe(false);
    expect(manifest.path).toBe(canonicalize(projectRoot));
    expect(manifest.created).toBe(created);
  });

  test("a v2 manifest is migrated to v3 in place, keeping path and created", async () => {
    const created = "2026-06-02T00:00:00.000Z";
    const { projectRoot, corpusHome } = writeLegacyV2Manifest(created);

    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });

    const manifest = JSON.parse(readFileSync(corpus.manifestPath, "utf8"));
    expect(manifest.format_version).toBe(3);
    expect(manifest.path).toBe(canonicalize(projectRoot));
    expect(manifest.created).toBe(created);
    expect("name" in manifest).toBe(false);
  });

  test("migration is idempotent: a second resolve leaves the v3 manifest untouched", async () => {
    const created = "2026-05-01T00:00:00.000Z";
    const { projectRoot, corpusHome } = writeLegacyV1Manifest(created);

    const first = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
    const afterFirst = readFileSync(first.manifestPath, "utf8");
    await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
    const afterSecond = readFileSync(first.manifestPath, "utf8");

    expect(afterSecond).toBe(afterFirst);
    expect(JSON.parse(afterSecond).created).toBe(created);
  });
});

describe("named corpus", () => {
  const CORPUS_NAME = "shared-corpus";

  test("two working copies with one name resolve to the same corpus directory", async () => {
    const copyA = tempProject();
    const copyB = tempProject();
    const corpusHome = tempHome();

    const first = await resolveCorpus(copyA, { corpusHome, corpusName: CORPUS_NAME, clock: fixedClock });
    const second = await resolveCorpus(copyB, { corpusHome, corpusName: CORPUS_NAME, clock: fixedClock });

    expect(first.corpusDir).toBe(join(corpusHome, CORPUS_NAME));
    expect(second.corpusDir).toBe(first.corpusDir);
    expect(second.canonicalRoot).toBe(canonicalize(copyB));
    expect(first.canonicalRoot).not.toBe(second.canonicalRoot);

    const manifest = JSON.parse(readFileSync(second.manifestPath, "utf8"));
    expect(manifest.name).toBe(CORPUS_NAME);
    expect(manifest.format_version).toBe(3);
    expect(manifest.path).toBe(canonicalize(copyA));
  });

  test("the name travels from a real .mneme.json through loadConfig into the resolution", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    writeFileSync(
      join(projectRoot, CONFIG_FILE_NAME),
      JSON.stringify({ corpus: { name: CORPUS_NAME } }),
    );

    const corpusName = loadConfig(projectRoot, {}).corpus.name;
    const corpus = await resolveCorpus(projectRoot, { corpusHome, corpusName, clock: fixedClock });

    expect(corpusName).toBe(CORPUS_NAME);
    expect(corpus.corpusDir).toBe(join(corpusHome, CORPUS_NAME));
    expect(corpusDirFor(projectRoot, corpusHome, corpusName).corpusDir).toBe(corpus.corpusDir);
  });

  test("a directory renamed away from the name its manifest carries is refused", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpus = await resolveCorpus(projectRoot, { corpusHome, corpusName: CORPUS_NAME, clock: fixedClock });
    renameSync(corpus.corpusDir, join(corpusHome, "other-corpus"));

    await expect(
      resolveCorpus(projectRoot, { corpusHome, corpusName: "other-corpus", clock: fixedClock }),
    ).rejects.toThrow(CorpusError);
  });

  test("an unnamed corpus found under a requested name is adopted by stamping the name in", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();
    const corpusDir = join(corpusHome, CORPUS_NAME);
    const foreignPath = canonicalize(tempProject());
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      join(corpusDir, MANIFEST_FILENAME),
      JSON.stringify({ path: foreignPath, created: "2026-04-01T00:00:00.000Z", format_version: 2 }),
    );

    const corpus = await resolveCorpus(projectRoot, { corpusHome, corpusName: CORPUS_NAME, clock: fixedClock });

    const manifest = JSON.parse(readFileSync(corpus.manifestPath, "utf8"));
    expect(manifest.name).toBe(CORPUS_NAME);
    expect(manifest.format_version).toBe(3);
    expect(manifest.path).toBe(foreignPath);
    expect(manifest.created).toBe("2026-04-01T00:00:00.000Z");
  });

  test("without a name the derivation stays munged and the manifest carries no name", async () => {
    const projectRoot = tempProject();
    const corpusHome = tempHome();

    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });

    expect(corpus.corpusDir).toBe(join(corpusHome, mungePath(canonicalize(projectRoot))));
    expect(corpusDirFor(projectRoot, corpusHome).corpusDir).toBe(corpus.corpusDir);
    expect("name" in JSON.parse(readFileSync(corpus.manifestPath, "utf8"))).toBe(false);
  });
});
