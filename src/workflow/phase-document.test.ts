import { describe, expect, test } from "bun:test";
import {
  PhaseDocumentValidationError,
  parsePhaseDocument,
  serializePhaseDocument,
} from "./phase-document";
import type { DoneWhenCriterion, PhaseDocument } from "./phase-document";

const baseDocument: PhaseDocument = {
  id: "phase-seven",
  deps: ["phase-six"],
  agentRole: "coder",
  description: "Build the reducer core.",
  tasks: ["Implement the parser"],
  doneWhen: [{ kind: "executable", description: "tests pass", command: "bun test" }],
  knowledge: [],
};

function document(overrides: Partial<PhaseDocument>): PhaseDocument {
  return { ...baseDocument, ...overrides };
}

function serializeWith(overrides: Partial<PhaseDocument>): () => string {
  return () => serializePhaseDocument(document(overrides));
}

const canonicalText = [
  "---",
  'id: "phase-seven"',
  'deps: ["phase-six"]',
  'agent-role: "coder"',
  "---",
  "Build the reducer core.",
  "",
  "## Tasks",
  "- Implement the parser",
  "",
  "## Done-when",
  "- tests pass",
  "```",
  "bun test",
  "```",
  "",
].join("\n");

const canonicalTextWithAgentJudged = [
  "---",
  'id: "phase-seven"',
  'deps: ["phase-six"]',
  'agent-role: "coder"',
  "---",
  "Build the reducer core.",
  "",
  "## Tasks",
  "- Implement the parser",
  "",
  "## Done-when",
  "- tests pass",
  "```",
  "bun test",
  "```",
  "- reviewer approves",
  "agent-judged: true",
  "",
].join("\n");

const frontmatterLines = ['id: "phase-seven"', "deps: []", 'agent-role: "coder"'];
const bodyLines = [
  "## Tasks",
  "- Implement the parser",
  "",
  "## Done-when",
  "- tests pass",
  "```",
  "bun test",
  "```",
];

function phaseText(frontmatter: string[] = frontmatterLines, body: string[] = bodyLines): string {
  return ["---", ...frontmatter, "---", ...body, ""].join("\n");
}

function parseOf(text: string): () => PhaseDocument {
  return () => parsePhaseDocument(text);
}

describe("phase document round-trip", () => {
  test("serialize then parse preserves a document with a description", () => {
    const original = document({});
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("serialize then parse preserves a document without a description", () => {
    const original = document({ description: "" });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("serialize then parse preserves a multi-line description with an internal blank line", () => {
    const original = document({ description: "First paragraph.\n\nSecond paragraph." });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("serialize then parse preserves multiple tasks and criteria", () => {
    const original = document({
      tasks: ["Write the parser", "Write the serializer", "Wire validation"],
      doneWhen: [
        { kind: "executable", description: "tests pass", command: "bun test" },
        { kind: "executable", description: "types check", command: "bunx tsc --noEmit" },
      ],
    });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("serialize then parse preserves empty deps", () => {
    const original = document({ deps: [] });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("serialize then parse preserves multiple deps in order", () => {
    const original = document({ deps: ["phase-two", "phase-one"] });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("canonical text is byte-stable through parse and serialize", () => {
    expect(serializePhaseDocument(parsePhaseDocument(canonicalText))).toBe(canonicalText);
  });

  test("re-serialization is stable", () => {
    const text = serializePhaseDocument(document({}));
    expect(serializePhaseDocument(parsePhaseDocument(text))).toBe(text);
  });
});

describe("phase document knowledge section", () => {
  test("serialize then parse preserves a document with knowledge bullets", () => {
    const original = document({ knowledge: ["prefer git anchors", "cosine dedup only"] });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("a knowledge-bearing document serializes a ## Knowledge section with its bullets", () => {
    const text = serializePhaseDocument(document({ knowledge: ["first note", "second note"] }));
    expect(text).toContain("## Knowledge");
    expect(text).toContain("- first note");
    expect(text).toContain("- second note");
  });

  test("an empty knowledge list emits no ## Knowledge section and parses back to []", () => {
    const text = serializePhaseDocument(document({ knowledge: [] }));
    expect(text).not.toContain("## Knowledge");
    expect(parsePhaseDocument(text).knowledge).toEqual([]);
  });

  test("a serialized document without a ## Knowledge section parses with knowledge === []", () => {
    expect(parsePhaseDocument(canonicalText).knowledge).toEqual([]);
  });

  test("a ## Knowledge section is parsed into the knowledge bullets", () => {
    const parsed = parsePhaseDocument(
      phaseText(frontmatterLines, [
        "## Tasks",
        "- Implement the parser",
        "",
        "## Done-when",
        "- tests pass",
        "```",
        "bun test",
        "```",
        "",
        "## Knowledge",
        "- anchor notes to commits",
        "- staleness is deterministic",
      ]),
    );
    expect(parsed.knowledge).toEqual(["anchor notes to commits", "staleness is deterministic"]);
  });

  test("a ## Knowledge section before ## Done-when is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Knowledge",
          "- too early",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a duplicate ## Knowledge section is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
          "",
          "## Knowledge",
          "- first",
          "",
          "## Knowledge",
          "- again",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a forbidden character in a knowledge bullet is rejected", () => {
    expect(serializeWith({ knowledge: [`safe${String.fromCharCode(0x00)}bullet`] })).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("a newline in a knowledge bullet is rejected", () => {
    expect(serializeWith({ knowledge: ["first\nsecond"] })).toThrow(PhaseDocumentValidationError);
  });

  test("a blank knowledge bullet is rejected, matching task and criterion validation", () => {
    expect(serializeWith({ knowledge: ["   "] })).toThrow(PhaseDocumentValidationError);
  });

  test("a bare '- ' knowledge bullet is rejected on parse", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
          "",
          "## Knowledge",
          "- ",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a non-bullet line inside a ## Knowledge section is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
          "",
          "## Knowledge",
          "stray prose",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });
});

describe("phase document agent-judged grammar", () => {
  test("serialize then parse preserves an agent-judged criterion", () => {
    const original = document({
      doneWhen: [{ kind: "agent-judged", description: "reviewer approves" }],
    });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("serialize then parse preserves a document mixing both criterion kinds", () => {
    const original = document({
      doneWhen: [
        { kind: "executable", description: "tests pass", command: "bun test" },
        { kind: "agent-judged", description: "reviewer approves" },
      ],
    });
    expect(parsePhaseDocument(serializePhaseDocument(original))).toEqual(original);
  });

  test("canonical text with an agent-judged criterion is byte-stable", () => {
    expect(serializePhaseDocument(parsePhaseDocument(canonicalTextWithAgentJudged))).toBe(
      canonicalTextWithAgentJudged,
    );
  });

  test("a marker on the line after the bullet parses as agent-judged", () => {
    const parsed = parsePhaseDocument(
      phaseText(frontmatterLines, [
        "## Tasks",
        "- Implement the parser",
        "",
        "## Done-when",
        "- reviewer approves",
        "agent-judged: true",
      ]),
    );
    expect(parsed.doneWhen).toEqual([{ kind: "agent-judged", description: "reviewer approves" }]);
  });

  test("an agent-judged: false line is rejected as a missing fence", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- reviewer approves",
          "agent-judged: false",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a marker without a preceding bullet is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "agent-judged: true",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a marker followed by a stray fence is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- reviewer approves",
          "agent-judged: true",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a blank line between the bullet and the marker is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- reviewer approves",
          "",
          "agent-judged: true",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a forbidden character in an agent-judged description is rejected", () => {
    expect(
      serializeWith({
        doneWhen: [
          { kind: "agent-judged", description: `reviewer${String.fromCharCode(0x00)}approves` },
        ],
      }),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("a criterion with an unknown kind is rejected", () => {
    const criterion = {
      kind: "mystery",
      description: "reviewer approves",
    } as unknown as DoneWhenCriterion;
    expect(serializeWith({ doneWhen: [criterion] })).toThrow(PhaseDocumentValidationError);
  });
});

describe("phase document parse tolerance", () => {
  test("language-tagged fence is accepted and the tag is discarded", () => {
    const parsed = parsePhaseDocument(
      phaseText(frontmatterLines, [
        "## Tasks",
        "- Implement the parser",
        "",
        "## Done-when",
        "- tests pass",
        "```bash",
        "bun test",
        "```",
      ]),
    );
    expect(parsed.doneWhen).toEqual([{ kind: "executable", description: "tests pass", command: "bun test" }]);
  });

  test("extra blank lines between sections, bullets and criteria are tolerated", () => {
    const parsed = parsePhaseDocument(
      phaseText(frontmatterLines, [
        "",
        "## Tasks",
        "",
        "- First task",
        "",
        "- Second task",
        "",
        "",
        "## Done-when",
        "",
        "- tests pass",
        "```",
        "bun test",
        "```",
        "",
        "- types check",
        "```",
        "bunx tsc --noEmit",
        "```",
        "",
      ]),
    );
    expect(parsed.tasks).toEqual(["First task", "Second task"]);
    expect(parsed.doneWhen).toEqual([
      { kind: "executable", description: "tests pass", command: "bun test" },
      { kind: "executable", description: "types check", command: "bunx tsc --noEmit" },
    ]);
  });
});

describe("phase id grammar", () => {
  test("single-character id is accepted", () => {
    expect(serializeWith({ id: "a" })).not.toThrow();
  });

  test("64-character id is accepted", () => {
    expect(serializeWith({ id: "a".repeat(64) })).not.toThrow();
  });

  test("65-character id is rejected", () => {
    expect(serializeWith({ id: "a".repeat(65) })).toThrow(PhaseDocumentValidationError);
  });

  test("uppercase id is rejected", () => {
    expect(serializeWith({ id: "Phase-Seven" })).toThrow(PhaseDocumentValidationError);
  });

  test("id starting with a digit is rejected", () => {
    expect(serializeWith({ id: "7phase" })).toThrow(PhaseDocumentValidationError);
  });

  test("id starting with a dash is rejected", () => {
    expect(serializeWith({ id: "-phase" })).toThrow(PhaseDocumentValidationError);
  });

  test("id ending with a dash is rejected", () => {
    expect(serializeWith({ id: "phase-" })).toThrow(PhaseDocumentValidationError);
  });

  test("id with a double dash is rejected", () => {
    expect(serializeWith({ id: "phase--seven" })).toThrow(PhaseDocumentValidationError);
  });

  test("id with an underscore is rejected", () => {
    expect(serializeWith({ id: "phase_seven" })).toThrow(PhaseDocumentValidationError);
  });

  test("empty id is rejected", () => {
    expect(serializeWith({ id: "" })).toThrow(PhaseDocumentValidationError);
  });
});

describe("agent-role grammar", () => {
  test("64-character agent-role is accepted", () => {
    expect(serializeWith({ agentRole: "a".repeat(64) })).not.toThrow();
  });

  test("65-character agent-role is rejected", () => {
    expect(serializeWith({ agentRole: "a".repeat(65) })).toThrow(PhaseDocumentValidationError);
  });

  test("path traversal agent-role is rejected", () => {
    expect(serializeWith({ agentRole: "../../etc/passwd" })).toThrow(PhaseDocumentValidationError);
  });

  test("agent-role with a leading dash is rejected", () => {
    expect(serializeWith({ agentRole: "--flag" })).toThrow(PhaseDocumentValidationError);
  });

  test("agent-role with a slash is rejected", () => {
    expect(serializeWith({ agentRole: "roles/coder" })).toThrow(PhaseDocumentValidationError);
  });

  test("agent-role with a backslash is rejected", () => {
    expect(serializeWith({ agentRole: "roles\\coder" })).toThrow(PhaseDocumentValidationError);
  });

  test("agent-role with a space is rejected", () => {
    expect(serializeWith({ agentRole: "senior coder" })).toThrow(PhaseDocumentValidationError);
  });

  test("agent-role with a dot is rejected", () => {
    expect(serializeWith({ agentRole: "coder.v2" })).toThrow(PhaseDocumentValidationError);
  });

  test("uppercase agent-role is rejected", () => {
    expect(serializeWith({ agentRole: "Coder" })).toThrow(PhaseDocumentValidationError);
  });
});

describe("phase document frontmatter parse rejection", () => {
  test("text without an opening fence is rejected", () => {
    expect(parseOf("just some prose")).toThrow(PhaseDocumentValidationError);
  });

  test("unterminated frontmatter is rejected", () => {
    expect(parseOf(`---\n${frontmatterLines.join("\n")}`)).toThrow(PhaseDocumentValidationError);
  });

  test("unknown frontmatter key is rejected", () => {
    expect(parseOf(phaseText([...frontmatterLines, 'owner: "me"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("duplicate frontmatter key is rejected", () => {
    const parse = parseOf(phaseText([...frontmatterLines, 'id: "phase-eight"']));
    expect(parse).toThrow(PhaseDocumentValidationError);
    expect(parse).toThrow(/duplicate frontmatter key/);
  });

  test("non-JSON frontmatter value is rejected", () => {
    expect(parseOf(phaseText(['id: phase-seven', "deps: []", 'agent-role: "coder"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("frontmatter line without a separator is rejected", () => {
    expect(parseOf(phaseText([...frontmatterLines, "dangling"]))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("missing id is rejected", () => {
    expect(parseOf(phaseText(["deps: []", 'agent-role: "coder"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("missing deps is rejected", () => {
    expect(parseOf(phaseText(['id: "phase-seven"', 'agent-role: "coder"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("missing agent-role is rejected", () => {
    expect(parseOf(phaseText(['id: "phase-seven"', "deps: []"]))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("non-string id is rejected", () => {
    expect(parseOf(phaseText(["id: 7", "deps: []", 'agent-role: "coder"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("non-array deps is rejected", () => {
    expect(
      parseOf(phaseText(['id: "phase-seven"', 'deps: "phase-six"', 'agent-role: "coder"'])),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("non-string deps element is rejected", () => {
    expect(parseOf(phaseText(['id: "phase-seven"', "deps: [7]", 'agent-role: "coder"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("dep with invalid grammar is rejected", () => {
    expect(
      parseOf(phaseText(['id: "phase-seven"', 'deps: ["Bad-Dep"]', 'agent-role: "coder"'])),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("duplicate deps are rejected", () => {
    expect(
      parseOf(
        phaseText(['id: "phase-seven"', 'deps: ["phase-six", "phase-six"]', 'agent-role: "coder"']),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("self-dependency is rejected", () => {
    const parse = parseOf(
      phaseText(['id: "phase-seven"', 'deps: ["phase-seven"]', 'agent-role: "coder"']),
    );
    expect(parse).toThrow(PhaseDocumentValidationError);
    expect(parse).toThrow(/must not depend on itself/);
  });

  test("empty agent-role is rejected", () => {
    expect(parseOf(phaseText(['id: "phase-seven"', "deps: []", 'agent-role: ""']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("multi-line agent-role is rejected", () => {
    expect(parseOf(phaseText(['id: "phase-seven"', "deps: []", 'agent-role: "co\\nder"']))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("agent-role with a control character is rejected", () => {
    expect(
      parseOf(phaseText(['id: "phase-seven"', "deps: []", 'agent-role: "co\\u0000der"'])),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("non-string agent-role is rejected", () => {
    expect(parseOf(phaseText(['id: "phase-seven"', "deps: []", "agent-role: 7"]))).toThrow(
      PhaseDocumentValidationError,
    );
  });
});

describe("phase document body parse rejection", () => {
  test("missing ## Tasks section is rejected", () => {
    expect(
      parseOf(phaseText(frontmatterLines, ["## Done-when", "- tests pass", "```", "bun test", "```"])),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("## Tasks without bullets is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("non-bullet content in ## Tasks is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "stray prose",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("empty task bullet is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- ",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("missing ## Done-when section is rejected", () => {
    expect(parseOf(phaseText(frontmatterLines, ["## Tasks", "- Implement the parser"]))).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("## Done-when without criteria is rejected", () => {
    expect(
      parseOf(phaseText(frontmatterLines, ["## Tasks", "- Implement the parser", "", "## Done-when"])),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("criterion bullet without a fence is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, ["## Tasks", "- Implement the parser", "", "## Done-when", "- tests pass"]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("criterion bullet followed by another bullet is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "- types check",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("criterion bullet separated from its fence by a blank line is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("fence without a preceding bullet is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("stray prose in ## Done-when is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "stray prose",
          "- tests pass",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("unclosed fence is rejected", () => {
    const parse = parseOf(
      phaseText(frontmatterLines, [
        "## Tasks",
        "- Implement the parser",
        "",
        "## Done-when",
        "- tests pass",
        "```",
        "bun test",
      ]),
    );
    expect(parse).toThrow(PhaseDocumentValidationError);
    expect(parse).toThrow(/unclosed fenced command block/);
  });

  test("empty command fence is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("blank command line is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("multi-line command is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "bunx tsc --noEmit",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("duplicate ## Tasks section is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Tasks",
          "- Implement the parser",
          "",
          "## Tasks",
          "- Again",
          "",
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("duplicate ## Done-when section is rejected", () => {
    const parse = parseOf(
      phaseText(frontmatterLines, [
        "## Tasks",
        "- Implement the parser",
        "",
        "## Done-when",
        "- tests pass",
        "```",
        "bun test",
        "```",
        "## Done-when",
        "- again",
        "```",
        "bun test",
        "```",
      ]),
    );
    expect(parse).toThrow(PhaseDocumentValidationError);
    expect(parse).toThrow(/duplicate section/);
  });

  test("## Done-when before ## Tasks is rejected", () => {
    expect(
      parseOf(
        phaseText(frontmatterLines, [
          "## Done-when",
          "- tests pass",
          "```",
          "bun test",
          "```",
          "",
          "## Tasks",
          "- Implement the parser",
        ]),
      ),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("unknown section header is rejected", () => {
    expect(
      parseOf(phaseText(frontmatterLines, ["## Notes", "free text", ...bodyLines])),
    ).toThrow(PhaseDocumentValidationError);
  });
});

describe("phase document serialize rejection", () => {
  test("empty tasks list is rejected", () => {
    expect(serializeWith({ tasks: [] })).toThrow(PhaseDocumentValidationError);
  });

  test("empty done-when list is rejected", () => {
    expect(serializeWith({ doneWhen: [] })).toThrow(PhaseDocumentValidationError);
  });

  test("blank task text is rejected", () => {
    expect(serializeWith({ tasks: ["  "] })).toThrow(PhaseDocumentValidationError);
  });

  test("task text with a newline is rejected", () => {
    expect(serializeWith({ tasks: ["first\nsecond"] })).toThrow(PhaseDocumentValidationError);
  });

  test("blank criterion description is rejected", () => {
    expect(
      serializeWith({ doneWhen: [{ kind: "executable", description: "", command: "bun test" }] }),
    ).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("blank command is rejected", () => {
    expect(
      serializeWith({ doneWhen: [{ kind: "executable", description: "tests pass", command: " " }] }),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("multi-line command is rejected", () => {
    expect(
      serializeWith({
        doneWhen: [{ kind: "executable", description: "tests pass", command: "bun\ntest" }],
      }),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("command starting with a fence is rejected", () => {
    expect(
      serializeWith({
        doneWhen: [{ kind: "executable", description: "tests pass", command: "```bun test" }],
      }),
    ).toThrow(PhaseDocumentValidationError);
  });

  test("description containing a section header line is rejected", () => {
    expect(serializeWith({ description: "intro\n## Tasks-like heading" })).toThrow(
      PhaseDocumentValidationError,
    );
  });

  test("description starting with a blank line is rejected", () => {
    expect(serializeWith({ description: "\nintro" })).toThrow(PhaseDocumentValidationError);
  });

  test("description ending with a blank line is rejected", () => {
    expect(serializeWith({ description: "intro\n" })).toThrow(PhaseDocumentValidationError);
  });
});

const forbiddenLineCharacters: ReadonlyArray<readonly [string, string]> = [
  ["a nul", String.fromCharCode(0x00)],
  ["a tab", "\t"],
  ["a vertical tab", String.fromCharCode(0x0b)],
  ["a carriage return", "\r"],
  ["an escape", String.fromCharCode(0x1b)],
  ["a unit separator", String.fromCharCode(0x1f)],
  ["a delete", String.fromCharCode(0x7f)],
  ["a padding character", String.fromCharCode(0x80)],
  ["a next-line", String.fromCharCode(0x85)],
  ["a control sequence introducer", String.fromCharCode(0x9b)],
  ["an application program command", String.fromCharCode(0x9f)],
  ["a soft hyphen", String.fromCharCode(0x00ad)],
  ["an arabic letter mark", String.fromCharCode(0x061c)],
  ["a mongolian vowel separator", String.fromCharCode(0x180e)],
  ["a zero-width space", String.fromCharCode(0x200b)],
  ["a zero-width joiner", String.fromCharCode(0x200d)],
  ["a right-to-left mark", String.fromCharCode(0x200f)],
  ["a line separator", String.fromCharCode(0x2028)],
  ["a paragraph separator", String.fromCharCode(0x2029)],
  ["a right-to-left override", String.fromCharCode(0x202e)],
  ["a word joiner", String.fromCharCode(0x2060)],
  ["an invisible plus", String.fromCharCode(0x2064)],
  ["a left-to-right isolate", String.fromCharCode(0x2066)],
  ["a pop directional isolate", String.fromCharCode(0x2069)],
  ["a zero-width no-break space", String.fromCharCode(0xfeff)],
  ["an interlinear annotation anchor", String.fromCharCode(0xfff9)],
  ["an interlinear annotation terminator", String.fromCharCode(0xfffb)],
  ["the first tag code point", String.fromCodePoint(0xe0000)],
  ["a tag capital letter a", String.fromCodePoint(0xe0041)],
  ["a cancel tag", String.fromCodePoint(0xe007f)],
];

describe("forbidden control character rejection", () => {
  for (const [characterName, character] of forbiddenLineCharacters) {
    test(`task text with ${characterName} is rejected`, () => {
      expect(serializeWith({ tasks: [`first${character}second`] })).toThrow(
        PhaseDocumentValidationError,
      );
    });

    test(`criterion description with ${characterName} is rejected`, () => {
      expect(
        serializeWith({
          doneWhen: [
            { kind: "executable", description: `tests${character}pass`, command: "bun test" },
          ],
        }),
      ).toThrow(PhaseDocumentValidationError);
    });

    test(`done-when command with ${characterName} is rejected`, () => {
      expect(
        serializeWith({
          doneWhen: [
            { kind: "executable", description: "tests pass", command: `bun${character}test` },
          ],
        }),
      ).toThrow(PhaseDocumentValidationError);
    });

    test(`description with ${characterName} is rejected`, () => {
      expect(serializeWith({ description: `intro${character}outro` })).toThrow(
        PhaseDocumentValidationError,
      );
    });
  }
});
