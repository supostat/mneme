import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

// The index is a cache over notes/ and map/, and a rebuild that fails after a committed write leaves
// it complete but behind the files. Nothing in the index itself can say so — the failed rebuild never
// reached it — so the staleness lives beside it, in a marker file the "rebuild before reading"
// predicate reads. A refresh that fails writes the marker; only a rebuild that read the sources
// AFTER the marker appeared may remove it.
//
// The marker carries a fresh token per failure. A rebuild reads the token before it reads the
// sources and, once its swap committed, removes the marker only if the token is still the one it
// saw: a failure in another session during this rebuild writes a new token, and that marker stays
// for the next read to act on. A process killed mid-rebuild never reaches the removal, so a crash
// can only leave a marker behind, never lose one.

const STALE_MARKER_SUFFIX = "-stale";
const CLAIM_SUFFIX = "-claimed-";
const MISSING_FILE_CODE = "ENOENT";

export function indexStaleMarkerPath(indexPath: string): string {
  return `${indexPath}${STALE_MARKER_SUFFIX}`;
}

export function markIndexStale(indexPath: string): void {
  writeFileSync(indexStaleMarkerPath(indexPath), randomUUID());
}

export function isIndexMarkedStale(indexPath: string): boolean {
  return existsSync(indexStaleMarkerPath(indexPath));
}

// null when the index is not marked stale.
export function readIndexStaleToken(indexPath: string): string | null {
  try {
    return readFileSync(indexStaleMarkerPath(indexPath), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

// Compare-and-delete without a lock. The marker is first renamed to a name of its own — atomic, so
// exactly one rebuild claims it — and only then compared. A token other than the one seen at the
// start goes back under the marker name: if yet another failure wrote a marker meanwhile, the
// rename-back replaces one "stale" with another, which says the same thing. A rebuild that started
// with no marker removes nothing: whatever appeared since belongs to a failure it may not have read.
export function clearIndexStaleMarker(indexPath: string, tokenSeenAtStart: string | null): void {
  if (tokenSeenAtStart === null) return;
  const markerPath = indexStaleMarkerPath(indexPath);
  const claimedPath = `${markerPath}${CLAIM_SUFFIX}${randomUUID()}`;
  try {
    renameSync(markerPath, claimedPath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (readFileSync(claimedPath, "utf8") === tokenSeenAtStart) {
    rmSync(claimedPath);
  } else {
    renameSync(claimedPath, markerPath);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === MISSING_FILE_CODE;
}
