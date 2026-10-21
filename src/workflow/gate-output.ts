import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A gate command's stdout and stderr go to one REGULAR FILE, never to a pipe. Draining a pipe to EOF
// after a SIGKILL hangs forever when the killed command left a grandchild holding the write end; a
// regular file has no EOF to wait for — a read returns whatever is on disk at that moment, and a
// grandchild still writing afterwards holds nothing up. Both streams share ONE open file description,
// which is what makes their interleaving read like a terminal's 2>&1.

export const OUTPUT_TAIL_MAX_BYTES = 4096;
export const OUTPUT_TAIL_MAX_LINES = 40;

const CAPTURE_DIRECTORY_PREFIX = "mneme-gate-";
const CAPTURE_FILE_NAME = "output.log";
const LINE_FEED = "\n";
const CARRIAGE_RETURN = "\r";

// CSI sequences (colors, cursor moves) and OSC sequences (hyperlinks, titles) are terminal control,
// not output: they are removed whole before the per-character strip, so no "[31m" debris survives.
const ANSI_CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
// C0 controls except tab, DEL, C1 controls (U+0085 included) and the line/paragraph separators —
// the engine's responses carry none of them (the run-directives rendering contract).
const UNRENDERABLE_CHARACTER = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/gu;

export interface OutputCapture {
  directory: string;
  path: string;
  descriptor: number;
}

export function createOutputCapture(): OutputCapture {
  const directory = mkdtempSync(join(tmpdir(), CAPTURE_DIRECTORY_PREFIX));
  const path = join(directory, CAPTURE_FILE_NAME);
  try {
    return { directory, path, descriptor: openSync(path, "a") };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function readOutputTail(path: string): string[] {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const start = Math.max(0, size - OUTPUT_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, start);
    return tailLines(buffer.subarray(0, bytesRead).toString("utf8"), start > 0);
  } finally {
    closeSync(descriptor);
  }
}

export function removeOutputCapture(capture: OutputCapture): void {
  rmSync(capture.directory, { recursive: true, force: true });
}

// A window cut out of the middle of the file starts inside a line (possibly inside a multi-byte
// character), so its first line is dropped rather than shown as a fragment.
function tailLines(text: string, startsMidFile: boolean): string[] {
  const lines = text.split(LINE_FEED);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (startsMidFile) {
    lines.shift();
  }
  return lines.slice(-OUTPUT_TAIL_MAX_LINES).map(renderableLine);
}

// A carriage return redraws the line in a terminal, so only the text after the last one is what a
// person would have seen; a trailing one is just the CR of a CRLF ending.
function renderableLine(line: string): string {
  const withoutLineEnding = line.endsWith(CARRIAGE_RETURN) ? line.slice(0, -CARRIAGE_RETURN.length) : line;
  const visible = withoutLineEnding.slice(withoutLineEnding.lastIndexOf(CARRIAGE_RETURN) + 1);
  return visible.replace(ANSI_CONTROL_SEQUENCE, "").replace(UNRENDERABLE_CHARACTER, "");
}
