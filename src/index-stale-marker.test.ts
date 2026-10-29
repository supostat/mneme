import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearIndexStaleMarker,
  indexStaleMarkerPath,
  isIndexMarkedStale,
  markIndexStale,
  readIndexStaleToken,
} from "./index-stale-marker";

function indexPathInFreshDir(): { corpusDir: string; indexPath: string } {
  const corpusDir = mkdtempSync(join(tmpdir(), "mneme-stale-marker-"));
  return { corpusDir, indexPath: join(corpusDir, "index.db") };
}

describe("index stale marker", () => {
  test("the marker lives beside the index and an unmarked index reads as no token", () => {
    const { indexPath } = indexPathInFreshDir();

    expect(indexStaleMarkerPath(indexPath)).toBe(`${indexPath}-stale`);
    expect(isIndexMarkedStale(indexPath)).toBe(false);
    expect(readIndexStaleToken(indexPath)).toBeNull();
  });

  test("every mark writes a fresh token", () => {
    const { indexPath } = indexPathInFreshDir();

    markIndexStale(indexPath);
    const first = readIndexStaleToken(indexPath);
    markIndexStale(indexPath);
    const second = readIndexStaleToken(indexPath);

    expect(isIndexMarkedStale(indexPath)).toBe(true);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  test("a clear with the token seen at the start removes the marker and leaves no claimed copy", () => {
    const { corpusDir, indexPath } = indexPathInFreshDir();
    markIndexStale(indexPath);
    const seen = readIndexStaleToken(indexPath);

    clearIndexStaleMarker(indexPath, seen);

    expect(isIndexMarkedStale(indexPath)).toBe(false);
    expect(readdirSync(corpusDir)).toEqual([]);
  });

  test("a marker rewritten after the start survives the clear with its own token", () => {
    const { corpusDir, indexPath } = indexPathInFreshDir();
    markIndexStale(indexPath);
    const seen = readIndexStaleToken(indexPath);
    markIndexStale(indexPath);
    const newer = readIndexStaleToken(indexPath);

    clearIndexStaleMarker(indexPath, seen);

    expect(readIndexStaleToken(indexPath)).toBe(newer);
    expect(readdirSync(corpusDir)).toEqual(["index.db-stale"]);
  });

  test("a rebuild that started unmarked removes nothing, not even a marker that appeared since", () => {
    const { indexPath } = indexPathInFreshDir();
    markIndexStale(indexPath);
    const appeared = readIndexStaleToken(indexPath);

    clearIndexStaleMarker(indexPath, null);

    expect(readIndexStaleToken(indexPath)).toBe(appeared);
  });

  test("a marker another rebuild already removed is a quiet no-op", () => {
    const { corpusDir, indexPath } = indexPathInFreshDir();
    markIndexStale(indexPath);
    const seen = readIndexStaleToken(indexPath);
    clearIndexStaleMarker(indexPath, seen);

    clearIndexStaleMarker(indexPath, seen);

    expect(isIndexMarkedStale(indexPath)).toBe(false);
    expect(readdirSync(corpusDir)).toEqual([]);
  });
});
