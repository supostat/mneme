import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATASET_SOURCES, main } from "./download";
import type { DownloadFetch } from "./download";

function collectingLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

function fetchReturning(body: string): DownloadFetch {
  return async () => new Response(body, { status: 200 });
}

const fetchFailing: DownloadFetch = async () => new Response("gone", { status: 404 });

describe("download main", () => {
  test("saves a fetched dataset and exits 0", async () => {
    const datasetsDir = mkdtempSync(join(tmpdir(), "mneme-bench-datasets-"));
    const { lines, log } = collectingLog();
    const code = await main(["locomo"], {
      fetchImplementation: fetchReturning("[]"),
      datasetsDir,
      log,
    });
    expect(code).toBe(0);
    const target = join(datasetsDir, DATASET_SOURCES.locomo.file);
    expect(readFileSync(target, "utf8")).toBe("[]");
    expect(lines.some((line) => line.includes("saved"))).toBe(true);
  });

  test("failed fetch leaves nothing behind and exits 2 with the manual instruction", async () => {
    const datasetsDir = mkdtempSync(join(tmpdir(), "mneme-bench-datasets-"));
    const { lines, log } = collectingLog();
    const code = await main(["longmemeval-s"], {
      fetchImplementation: fetchFailing,
      datasetsDir,
      log,
    });
    expect(code).toBe(2);
    expect(existsSync(join(datasetsDir, DATASET_SOURCES["longmemeval-s"].file))).toBe(false);
    expect(lines.some((line) => line.includes("manual step"))).toBe(true);
  });

  test("a body that is not JSON is refused, never written", async () => {
    const datasetsDir = mkdtempSync(join(tmpdir(), "mneme-bench-datasets-"));
    const { log } = collectingLog();
    const code = await main(["locomo"], {
      fetchImplementation: fetchReturning("<html>rate limited</html>"),
      datasetsDir,
      log,
    });
    expect(code).toBe(2);
    expect(existsSync(join(datasetsDir, DATASET_SOURCES.locomo.file))).toBe(false);
  });

  test("an already-present file is kept without refetching", async () => {
    const datasetsDir = mkdtempSync(join(tmpdir(), "mneme-bench-datasets-"));
    const target = join(datasetsDir, DATASET_SOURCES.locomo.file);
    writeFileSync(target, "[1]");
    const { lines, log } = collectingLog();
    const fetchExploding: DownloadFetch = async () => {
      throw new Error("must not be called");
    };
    const code = await main(["locomo"], { fetchImplementation: fetchExploding, datasetsDir, log });
    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("[1]");
    expect(lines.some((line) => line.includes("already present"))).toBe(true);
  });

  test("an unknown dataset name prints usage and exits 2", async () => {
    const datasetsDir = mkdtempSync(join(tmpdir(), "mneme-bench-datasets-"));
    const { lines, log } = collectingLog();
    const code = await main(["nope"], { fetchImplementation: fetchFailing, datasetsDir, log });
    expect(code).toBe(2);
    expect(lines[0]!.startsWith("usage:")).toBe(true);
  });
});
