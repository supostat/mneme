import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./dispatch";

// The dispatcher routes on the first word and nothing else: each subcommand then checks its own
// grammar, so a bad flag is refused with THAT subcommand's usage — which is what tells the routes
// apart here — and an unknown first word with the usage of every subcommand.

interface CapturedInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function dispatch(argv: string[]): Promise<CapturedInvocation> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    projectRoot: mkdtempSync(join(tmpdir(), "mneme-dispatch-proj-")),
    corpusHome: mkdtempSync(join(tmpdir(), "mneme-dispatch-home-")),
    environment: {},
    isProcessAlive: () => true,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

describe("runCli", () => {
  test("survey routes to the survey subcommand", async () => {
    expect(await dispatch(["survey", "--full"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: 'unknown invocation "survey --full"\nusage: mneme survey --brief\n',
    });
    expect(await dispatch(["survey", "--brief"])).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("diary routes to the diary subcommand", async () => {
    expect(await dispatch(["diary", "--full"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: 'unknown invocation "diary --full"\nusage: mneme diary --brief\n',
    });
    expect(await dispatch(["diary", "--brief"])).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("an unknown subcommand is refused with every subcommand's usage and exit 2", async () => {
    expect(await dispatch(["doctor"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: 'unknown invocation "doctor"\nusage: mneme survey --brief\nusage: mneme diary --brief\n',
    });
  });
});
