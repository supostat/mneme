import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertVault, VaultConversionError } from "./vault-converter";
import type { KnowledgeRouting } from "./vault-converter";

const EM_DASH = String.fromCharCode(0x2014);

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface PhaseFileSpec {
  number: number;
  slug: string;
  title: string;
  dependsOn: number | null | "omit";
  tasks: string[];
  goal: string;
}

function newVault(): string {
  const vaultPath = mkdtempSync(join(tmpdir(), "mneme-vault-converter-"));
  temporaryDirectories.push(vaultPath);
  mkdirSync(join(vaultPath, "phases"));
  return vaultPath;
}

function renderPhaseFile(spec: PhaseFileSpec): string {
  const frontmatter = ["---", `phase: ${spec.number}`, `name: ${spec.slug}`, "status: pending"];
  if (spec.dependsOn !== "omit") {
    frontmatter.push(`depends_on: ${spec.dependsOn === null ? "null" : spec.dependsOn}`);
  }
  frontmatter.push("---");
  return [
    ...frontmatter,
    "",
    `# Phase ${spec.number}: ${spec.slug} ${EM_DASH} ${spec.title}`,
    "",
    "## Goal",
    spec.goal,
    "",
    "## Tasks",
    ...spec.tasks.map((task, index) => `${index + 1}. ${task}`),
    "",
  ].join("\n");
}

function writePhaseFile(vaultPath: string, spec: PhaseFileSpec): void {
  const fileName = `phase-${spec.number}-${spec.slug}.md`;
  writeFileSync(join(vaultPath, "phases", fileName), renderPhaseFile(spec));
}

function writeGameplan(vaultPath: string, rosterHeadings: string[], includeBacklog = true): void {
  const lines = ["# Gameplan", "", "## Current Phase", "", "Some current-phase note.", "", "## Phases", ""];
  for (const heading of rosterHeadings) {
    lines.push(heading, "");
  }
  if (includeBacklog) {
    lines.push("## Backlog", "", `### Phase 99: ignored ${EM_DASH} not in the roster`, "");
  }
  writeFileSync(join(vaultPath, "gameplan.md"), lines.join("\n"));
}

function writeKnowledge(vaultPath: string, sections: ReadonlyArray<readonly [string, string]>): void {
  const lines = ["# Knowledge", ""];
  for (const [heading, content] of sections) {
    lines.push(`## ${heading}`, "", content, "");
  }
  writeFileSync(join(vaultPath, "knowledge.md"), lines.join("\n"));
}

const happyRouting: KnowledgeRouting = {
  Architecture: "claude-md",
  Gotchas: "mneme-notes",
  Security: "docs",
};

function writeHappyVault(): string {
  const vaultPath = newVault();
  writePhaseFile(vaultPath, {
    number: 1,
    slug: "alpha",
    title: "first",
    dependsOn: null,
    tasks: ["do alpha"],
    goal: "alpha is green.",
  });
  writePhaseFile(vaultPath, {
    number: 2,
    slug: "beta",
    title: "second",
    dependsOn: 1,
    tasks: ["do beta"],
    goal: "beta is green.",
  });
  writePhaseFile(vaultPath, {
    number: 3,
    slug: "gamma",
    title: "third",
    dependsOn: 2,
    tasks: ["do gamma"],
    goal: "gamma is green.",
  });
  writeGameplan(vaultPath, [
    `### Phase 1: alpha ${EM_DASH} first`,
    `### Phase 2: beta ${EM_DASH} second`,
    `### Phase 3: gamma ${EM_DASH} third`,
  ]);
  writeKnowledge(vaultPath, [
    ["Architecture", "Architecture content."],
    ["Gotchas", "Gotchas content."],
    ["Security", "Security content."],
  ]);
  return vaultPath;
}

describe("convertVault happy path", () => {
  test("derives one document per phase file with ids from the H1 slugs", () => {
    const conversion = convertVault(writeHappyVault(), happyRouting);
    expect(conversion.phases.map((phase) => phase.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("resolves dependencies through the explicit depends_on number map", () => {
    const conversion = convertVault(writeHappyVault(), happyRouting);
    expect(conversion.phases.map((phase) => phase.deps)).toEqual([[], ["alpha"], ["beta"]]);
  });

  test("attaches an executable done-when to every phase", () => {
    const conversion = convertVault(writeHappyVault(), happyRouting);
    for (const phase of conversion.phases) {
      expect(phase.doneWhen.every((criterion) => criterion.kind === "executable")).toBe(true);
    }
  });

  test("routes each knowledge section to its declared destination and preserves content", () => {
    const conversion = convertVault(writeHappyVault(), happyRouting);
    expect(conversion.knowledge.map((section) => [section.heading, section.destination])).toEqual([
      ["Architecture", "claude-md"],
      ["Gotchas", "mneme-notes"],
      ["Security", "docs"],
    ]);
    expect(conversion.knowledge[0]?.content).toContain("Architecture content.");
  });

  test("carries the phase title and goal prose into the description", () => {
    const conversion = convertVault(writeHappyVault(), happyRouting);
    expect(conversion.phases[0]?.description).toContain("first");
    expect(conversion.phases[0]?.description).toContain("alpha is green.");
  });
});

describe("convertVault edge cases", () => {
  test("treats depends_on null as no dependencies", () => {
    const conversion = convertVault(writeHappyVault(), happyRouting);
    expect(conversion.phases[0]?.deps).toEqual([]);
  });

  test("slugifies a compound H1 label", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "index & recall",
      title: "search",
      dependsOn: null,
      tasks: ["build index"],
      goal: "recall is relevant.",
    });
    writeGameplan(vaultPath, [`### Phase 1: index & recall ${EM_DASH} search`]);
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    const conversion = convertVault(vaultPath, { Architecture: "claude-md" });
    expect(conversion.phases[0]?.id).toBe("index-recall");
  });
});

describe("convertVault rejections", () => {
  test("throws when the gameplan lists a phase with no file", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: null,
      tasks: ["do alpha"],
      goal: "green.",
    });
    writeGameplan(vaultPath, [
      `### Phase 1: alpha ${EM_DASH} first`,
      `### Phase 2: beta ${EM_DASH} second`,
    ]);
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("throws when two phase files share a phase number", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 2,
      slug: "beta",
      title: "second",
      dependsOn: null,
      tasks: ["do beta"],
      goal: "green.",
    });
    writePhaseFile(vaultPath, {
      number: 2,
      slug: "delta",
      title: "also-second",
      dependsOn: null,
      tasks: ["do delta"],
      goal: "green.",
    });
    expect(() => convertVault(vaultPath, {})).toThrow(VaultConversionError);
  });

  test("throws when a depends_on points at a phase number with no file", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: null,
      tasks: ["do alpha"],
      goal: "green.",
    });
    writePhaseFile(vaultPath, {
      number: 2,
      slug: "beta",
      title: "second",
      dependsOn: 9,
      tasks: ["do beta"],
      goal: "green.",
    });
    writeGameplan(vaultPath, [
      `### Phase 1: alpha ${EM_DASH} first`,
      `### Phase 2: beta ${EM_DASH} second`,
    ]);
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("throws when a phase file omits the depends_on key entirely", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: "omit",
      tasks: ["do alpha"],
      goal: "green.",
    });
    expect(() => convertVault(vaultPath, {})).toThrow(VaultConversionError);
  });

  test("throws when a knowledge section is missing from the routing table", () => {
    const vaultPath = writeHappyVault();
    const routing: KnowledgeRouting = { Architecture: "claude-md", Gotchas: "mneme-notes" };
    expect(() => convertVault(vaultPath, routing)).toThrow(VaultConversionError);
  });

  test("throws when the routing table names a section absent from knowledge", () => {
    const vaultPath = writeHappyVault();
    const routing: KnowledgeRouting = {
      Architecture: "claude-md",
      Gotchas: "mneme-notes",
      Security: "docs",
      Deployment: "docs",
    };
    expect(() => convertVault(vaultPath, routing)).toThrow(VaultConversionError);
  });

  test("throws when the phases directory is missing", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "mneme-vault-converter-"));
    temporaryDirectories.push(vaultPath);
    expect(() => convertVault(vaultPath, {})).toThrow(VaultConversionError);
  });

  test("throws when gameplan.md is missing", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: null,
      tasks: ["do alpha"],
      goal: "green.",
    });
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("throws when knowledge.md is missing", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: null,
      tasks: ["do alpha"],
      goal: "green.",
    });
    writeGameplan(vaultPath, [`### Phase 1: alpha ${EM_DASH} first`]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("throws when a phase file exists but the gameplan roster omits it", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: null,
      tasks: ["do alpha"],
      goal: "green.",
    });
    writePhaseFile(vaultPath, {
      number: 2,
      slug: "beta",
      title: "second",
      dependsOn: 1,
      tasks: ["do beta"],
      goal: "green.",
    });
    writeGameplan(vaultPath, [`### Phase 1: alpha ${EM_DASH} first`]);
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("throws when the phases directory holds only a non-phase plan file", () => {
    const vaultPath = newVault();
    writeFileSync(join(vaultPath, "phases", "phase-1-alpha.plan.md"), "planning notes only");
    expect(() => convertVault(vaultPath, {})).toThrow(VaultConversionError);
  });

  test("throws when gameplan.md lacks a ## Phases section", () => {
    const vaultPath = newVault();
    writePhaseFile(vaultPath, {
      number: 1,
      slug: "alpha",
      title: "first",
      dependsOn: null,
      tasks: ["do alpha"],
      goal: "green.",
    });
    writeFileSync(
      join(vaultPath, "gameplan.md"),
      ["# Gameplan", "", "## Current Phase", "", "No phases section here."].join("\n"),
    );
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("throws when the phase file H1 number differs from its frontmatter phase", () => {
    const vaultPath = newVault();
    const fileText = [
      "---",
      "phase: 1",
      "name: alpha",
      "status: pending",
      "depends_on: null",
      "---",
      "",
      `# Phase 2: alpha ${EM_DASH} first`,
      "",
      "## Goal",
      "green.",
      "",
      "## Tasks",
      "1. do alpha",
      "",
    ].join("\n");
    writeFileSync(join(vaultPath, "phases", "phase-1-alpha.md"), fileText);
    writeGameplan(vaultPath, [`### Phase 1: alpha ${EM_DASH} first`]);
    writeKnowledge(vaultPath, [["Architecture", "content."]]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });

  test("rejects a knowledge section whose content carries an invisible character", () => {
    const vaultPath = writeHappyVault();
    const zeroWidthSpace = String.fromCharCode(0x200b);
    writeKnowledge(vaultPath, [
      ["Architecture", `poisoned${zeroWidthSpace}content.`],
      ["Gotchas", "Gotchas content."],
      ["Security", "Security content."],
    ]);
    expect(() => convertVault(vaultPath, happyRouting)).toThrow(VaultConversionError);
  });

  test("rejects a knowledge section whose heading carries a bidi override character", () => {
    const vaultPath = writeHappyVault();
    const rightToLeftOverride = String.fromCharCode(0x202e);
    const poisonedHeading = `Arch${rightToLeftOverride}itecture`;
    writeKnowledge(vaultPath, [
      [poisonedHeading, "content."],
      ["Gotchas", "Gotchas content."],
      ["Security", "Security content."],
    ]);
    const routing: KnowledgeRouting = {
      [poisonedHeading]: "claude-md",
      Gotchas: "mneme-notes",
      Security: "docs",
    };
    expect(() => convertVault(vaultPath, routing)).toThrow(VaultConversionError);
  });

  test("reports a __proto__ knowledge section as unrouted rather than silently routing it", () => {
    const vaultPath = writeHappyVault();
    writeKnowledge(vaultPath, [
      ["Architecture", "content."],
      ["__proto__", "injected content."],
    ]);
    expect(() => convertVault(vaultPath, { Architecture: "claude-md" })).toThrow(VaultConversionError);
  });
});
