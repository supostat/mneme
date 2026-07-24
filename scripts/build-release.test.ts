import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import packageJson from "../package.json";
import {
  RELEASE_TARGETS,
  CHECKSUMS_FILE_NAME,
  DISPATCH_FILE_NAME,
  DISPATCH_EVENT_TYPE,
  artifactName,
  checksumsContent,
  parseReleaseArguments,
  requireTagMatchesVersion,
  buildRelease,
  formatReleaseReport,
  main,
} from "./build-release";
import type { CompileFunction, ReleaseReport } from "./build-release";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The suite never runs a real compile: the injected compiler writes deterministic per-target
// content, so checksum assertions can recompute the expected digests independently.
const fakeCompile: CompileFunction = async (_binDir, outfile, target) => {
  writeFileSync(outfile, `binary for ${target}\n`);
};

function failingOn(failedTarget: string): CompileFunction {
  return async (_binDir, outfile, target) => {
    if (target === failedTarget) {
      throw new Error(`compile failed for ${target}`);
    }
    writeFileSync(outfile, `binary for ${target}\n`);
  };
}

function sha256OfContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// main() writes its report to stdout/stderr; swallow both so exit-code assertions stay quiet.
async function runMainSilently(argv: string[], releaseDirectory: string, compile: CompileFunction): Promise<number> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const swallow = (): boolean => true;
  process.stdout.write = swallow as typeof process.stdout.write;
  process.stderr.write = swallow as typeof process.stderr.write;
  try {
    return await main(argv, releaseDirectory, compile);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe("parseReleaseArguments", () => {
  test("no arguments means no tag gate", () => {
    expect(parseReleaseArguments([])).toEqual({ tag: undefined });
  });

  test("--tag with a ref is accepted", () => {
    expect(parseReleaseArguments(["--tag", "v1.2.3"])).toEqual({ tag: "v1.2.3" });
  });

  test("--tag without a ref is a usage error", () => {
    expect(() => parseReleaseArguments(["--tag"])).toThrow("invalid arguments");
  });

  test("extra arguments are a usage error", () => {
    expect(() => parseReleaseArguments(["--tag", "v1.2.3", "extra"])).toThrow("invalid arguments");
  });

  test("an unknown flag is a usage error", () => {
    expect(() => parseReleaseArguments(["--bogus", "v1.2.3"])).toThrow("invalid arguments");
  });
});

describe("requireTagMatchesVersion", () => {
  test("v-prefixed version passes", () => {
    expect(() => requireTagMatchesVersion("v1.2.3", "1.2.3")).not.toThrow();
  });

  test("a diverging tag names both sides in the error", () => {
    expect(() => requireTagMatchesVersion("v9.9.9", "1.2.3")).toThrow(
      "tag v9.9.9 does not match package.json version 1.2.3 (expected v1.2.3)",
    );
  });

  test("a tag without the v prefix is a mismatch", () => {
    expect(() => requireTagMatchesVersion("1.2.3", "1.2.3")).toThrow("does not match");
  });
});

describe("artifact naming and checksums format", () => {
  test("artifact names are deterministic: mneme-<version>-<target>", () => {
    expect(artifactName("0.1.5", "bun-linux-x64")).toBe("mneme-0.1.5-bun-linux-x64");
  });

  test("SHA256SUMS lines follow shasum -c: digest, two spaces, file name", () => {
    const content = checksumsContent([
      { target: "bun-linux-x64", fileName: "mneme-1.0.0-bun-linux-x64", sizeBytes: 1, sha256: "a".repeat(64) },
      { target: "bun-darwin-arm64", fileName: "mneme-1.0.0-bun-darwin-arm64", sizeBytes: 1, sha256: "b".repeat(64) },
    ]);
    expect(content).toBe(
      `${"a".repeat(64)}  mneme-1.0.0-bun-linux-x64\n${"b".repeat(64)}  mneme-1.0.0-bun-darwin-arm64\n`,
    );
  });
});

describe("buildRelease over the full matrix", () => {
  test("produces one artifact per target, in matrix order, under this package's version", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    const report = await buildRelease(releaseDirectory, fakeCompile);

    expect(report.version).toBe(packageJson.version);
    expect(report.artifacts.map((artifact) => artifact.fileName)).toEqual(
      RELEASE_TARGETS.map((target) => artifactName(packageJson.version, target)),
    );
    for (const artifact of report.artifacts) {
      expect(existsSync(join(releaseDirectory, artifact.fileName))).toBe(true);
    }
  });

  test("SHA256SUMS carries the real digest of every artifact", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    await buildRelease(releaseDirectory, fakeCompile);

    const written = readFileSync(join(releaseDirectory, CHECKSUMS_FILE_NAME), "utf8");
    const expectedLines = RELEASE_TARGETS.map(
      (target) =>
        `${sha256OfContent(`binary for ${target}\n`)}  ${artifactName(packageJson.version, target)}`,
    );
    expect(written).toBe(expectedLines.join("\n") + "\n");
  });

  test("a rerun clears stale artifacts from a previous build", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");
    await buildRelease(releaseDirectory, fakeCompile);
    const staleFile = join(releaseDirectory, "mneme-0.0.0-bun-stale-target");
    writeFileSync(staleFile, "stale");

    await buildRelease(releaseDirectory, fakeCompile);

    expect(existsSync(staleFile)).toBe(false);
  });

  test("dispatch.json carries the engine-release contract keyed by target", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    await buildRelease(releaseDirectory, fakeCompile);

    const dispatch = JSON.parse(readFileSync(join(releaseDirectory, DISPATCH_FILE_NAME), "utf8"));
    expect(dispatch.event_type).toBe(DISPATCH_EVENT_TYPE);
    expect(dispatch.client_payload.version).toBe(packageJson.version);
    expect(dispatch.client_payload.targets).toEqual([...RELEASE_TARGETS]);
    for (const target of RELEASE_TARGETS) {
      expect(dispatch.client_payload.sha256[target]).toBe(sha256OfContent(`binary for ${target}\n`));
    }
  });

  test("a failed target rejects the build and writes no SHA256SUMS and no dispatch.json", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    expect(buildRelease(releaseDirectory, failingOn("bun-linux-x64"))).rejects.toThrow(
      "compile failed for bun-linux-x64",
    );

    expect(existsSync(join(releaseDirectory, CHECKSUMS_FILE_NAME))).toBe(false);
    expect(existsSync(join(releaseDirectory, DISPATCH_FILE_NAME))).toBe(false);
  });
});

describe("formatReleaseReport", () => {
  test("renders version, per-artifact size and digest, entry count, and rounded build time", () => {
    const report: ReleaseReport = {
      version: "1.2.3",
      directory: "/tmp/dist-release",
      artifacts: [
        { target: "bun-linux-x64", fileName: "mneme-1.2.3-bun-linux-x64", sizeBytes: 64_568_930, sha256: "c".repeat(64) },
      ],
      buildTimeMs: 150.7,
    };

    const rendered = formatReleaseReport(report);

    expect(rendered).toContain("Built release 1.2.3 into /tmp/dist-release");
    expect(rendered).toContain("mneme-1.2.3-bun-linux-x64  61.6 MiB");
    expect(rendered).toContain(`sha256:${"c".repeat(64)}`);
    expect(rendered).toContain(`${CHECKSUMS_FILE_NAME}: 1 entries`);
    expect(rendered).toContain("151 ms");
  });
});

describe("exit codes fail closed", () => {
  test("a usage error returns 2 and builds nothing", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    expect(await runMainSilently(["--tag"], releaseDirectory, fakeCompile)).toBe(2);
    expect(existsSync(releaseDirectory)).toBe(false);
  });

  test("a tag mismatch returns 1 before any compile", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    expect(await runMainSilently(["--tag", "v0.0.0-wrong"], releaseDirectory, fakeCompile)).toBe(1);
    expect(existsSync(releaseDirectory)).toBe(false);
  });

  test("a matching tag builds and returns 0", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    expect(await runMainSilently(["--tag", `v${packageJson.version}`], releaseDirectory, fakeCompile)).toBe(0);
    expect(existsSync(join(releaseDirectory, CHECKSUMS_FILE_NAME))).toBe(true);
  });

  test("a compile failure returns 1", async () => {
    const releaseDirectory = join(makeTemporaryDirectory("mneme-release-"), "dist-release");

    expect(await runMainSilently([], releaseDirectory, failingOn("bun-darwin-x64"))).toBe(1);
    expect(existsSync(join(releaseDirectory, CHECKSUMS_FILE_NAME))).toBe(false);
  });
});
