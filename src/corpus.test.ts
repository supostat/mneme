import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus, canonicalize, mungePath, CorpusError } from "./corpus";
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
    expect(manifest.format_version).toBe(2);
    expect("embedding_model" in manifest).toBe(false);
    expect(typeof manifest.created).toBe("string");

    expect(await isRepo(corpus.corpusDir)).toBe(true);
    expect(readFileSync(join(corpus.corpusDir, ".gitignore"), "utf8")).toBe(
      "index.db\nevents/\n",
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

  test("a v1 manifest is migrated to v2 in place, dropping embedding_model", async () => {
    const created = "2026-05-01T00:00:00.000Z";
    const { projectRoot, corpusHome } = writeLegacyV1Manifest(created);

    const corpus = await resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });

    const manifest = JSON.parse(readFileSync(corpus.manifestPath, "utf8"));
    expect(manifest.format_version).toBe(2);
    expect("embedding_model" in manifest).toBe(false);
    expect(manifest.path).toBe(canonicalize(projectRoot));
    expect(manifest.created).toBe(created);
  });

  test("migration is idempotent: a second resolve leaves the v2 manifest untouched", async () => {
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
