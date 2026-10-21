import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTPUT_TAIL_MAX_BYTES,
  OUTPUT_TAIL_MAX_LINES,
  createOutputCapture,
  readOutputTail,
  removeOutputCapture,
} from "./gate-output";

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const DELETE = String.fromCharCode(0x7f);
const NEXT_LINE = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const TAB = "\t";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tailOf(content: string | Buffer): string[] {
  const directory = mkdtempSync(join(tmpdir(), "mneme-gate-output-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "output.log");
  writeFileSync(path, content);
  return readOutputTail(path);
}

function numberedLines(count: number, width: number): string[] {
  const padding = "x".repeat(width - 4);
  return Array.from({ length: count }, (_, index) => `${String(index).padStart(4, "0")}${padding}`);
}

describe("readOutputTail bounds", () => {
  test("a short output comes back whole, line by line", () => {
    expect(tailOf("first\nsecond\n")).toEqual(["first", "second"]);
  });

  test("an empty output is an empty tail", () => {
    expect(tailOf("")).toEqual([]);
  });

  test("a last line without a newline is kept", () => {
    expect(tailOf("first\nunterminated")).toEqual(["first", "unterminated"]);
  });

  test("a long output keeps only its last lines", () => {
    const lines = numberedLines(100, 10);

    expect(tailOf(`${lines.join("\n")}\n`)).toEqual(lines.slice(-OUTPUT_TAIL_MAX_LINES));
  });

  test("a byte-heavy output keeps only the last bytes and drops the line they cut into", () => {
    const lines = numberedLines(10, 1000);
    const tail = tailOf(`${lines.join("\n")}\n`);

    expect(tail.join("\n").length).toBeLessThanOrEqual(OUTPUT_TAIL_MAX_BYTES);
    expect(tail).toEqual(lines.slice(-tail.length));
    expect(tail.length).toBe(4);
  });

  test("a window that starts inside a multi-byte character yields no replacement characters", () => {
    const cyrillicLine = "я".repeat(3000);
    const tail = tailOf(`${cyrillicLine}\n${"готово"}\n`);

    expect(tail).toEqual(["готово"]);
  });
});

describe("readOutputTail renders only what a terminal would show", () => {
  test("color and hyperlink sequences are removed whole", () => {
    const colored = `${ESCAPE}[31mred${ESCAPE}[0m`;
    const hyperlink = `${ESCAPE}]8;;https://example.test${BELL}link${ESCAPE}]8;;${BELL}`;

    expect(tailOf(`${colored} and ${hyperlink}\n`)).toEqual(["red and link"]);
  });

  test("control characters, DEL, C1 and line separators are stripped while a tab stays", () => {
    const noisy = `a${NUL}b${BELL}c${DELETE}d${NEXT_LINE}e${LINE_SEPARATOR}f${TAB}g\n`;

    expect(tailOf(noisy)).toEqual([`abcdef${TAB}g`]);
  });

  test("a carriage-return progress line keeps only its final redraw", () => {
    expect(tailOf("10%\r50%\r100%\n")).toEqual(["100%"]);
  });

  test("a CRLF line ending is not mistaken for a redraw", () => {
    expect(tailOf("done\r\nnext\r\n")).toEqual(["done", "next"]);
  });

  test("cyrillic output survives intact", () => {
    expect(tailOf("тест пройден\n")).toEqual(["тест пройден"]);
  });
});

describe("output capture lifecycle", () => {
  test("a capture is a private directory with a writable output file", () => {
    const capture = createOutputCapture();
    try {
      writeSync(capture.descriptor, "written through the descriptor\n");
      closeSync(capture.descriptor);

      expect(statSync(capture.directory).mode & 0o777).toBe(0o700);
      expect(readOutputTail(capture.path)).toEqual(["written through the descriptor"]);
    } finally {
      removeOutputCapture(capture);
    }
  });

  test("removing a capture deletes its directory", () => {
    const capture = createOutputCapture();
    closeSync(capture.descriptor);

    removeOutputCapture(capture);

    expect(existsSync(capture.directory)).toBe(false);
  });
});
