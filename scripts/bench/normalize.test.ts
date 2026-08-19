import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizeError, parseDataset, parseLocomo, parseLongmemevalS } from "./normalize";

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
}

describe("parseLocomo", () => {
  const cases = parseLocomo(readFixture("locomo-mini.json"));
  const conversation = cases[0]!;

  test("one case per conversation with sessions in numeric order", () => {
    expect(cases.length).toBe(1);
    expect(conversation.id).toBe("conv-1");
    expect(conversation.sessions.map((session) => session.id)).toEqual([
      "conv-1:session_1",
      "conv-1:session_2",
    ]);
  });

  test("session text renders speaker-prefixed turns and keeps the session date", () => {
    const first = conversation.sessions[0]!;
    expect(first.date).toBe("1:00 pm on 1 May, 2023");
    expect(first.text).toBe(
      "Ann: I adopted a beagle named Rex last week.\nBen: Nice! I just started a pottery class.",
    );
    expect(first.entities).toEqual(["Ann", "Ben", "1:00 pm on 1 May, 2023"]);
  });

  test("evidence dia_ids map to session ids and deduplicate", () => {
    expect(conversation.questions[0]!.evidenceSessionIds).toEqual(["conv-1:session_1"]);
    expect(conversation.questions[1]!.evidenceSessionIds).toEqual(["conv-1:session_2"]);
  });

  test("category 5 becomes abstention with no evidence", () => {
    const adversarial = conversation.questions[2]!;
    expect(adversarial.category).toBe("abstention");
    expect(adversarial.evidenceSessionIds).toEqual([]);
  });

  test("non-adversarial categories stay standard", () => {
    expect(conversation.questions[0]!.category).toBe("standard");
    expect(conversation.questions[1]!.category).toBe("standard");
  });

  test("malformed input throws NormalizeError", () => {
    expect(() => parseLocomo("not an array")).toThrow(NormalizeError);
    expect(() => parseLocomo([{ sample_id: "x", conversation: {}, qa: [{ category: 1 }] }])).toThrow(
      NormalizeError,
    );
  });
});

describe("parseLongmemevalS", () => {
  const cases = parseLongmemevalS(readFixture("longmemeval-s-mini.json"));

  test("one case per question carrying its own haystack", () => {
    expect(cases.map((benchCase) => benchCase.id)).toEqual(["q-standard-1", "q-update-1", "q-none-1_abs"]);
    expect(cases[0]!.sessions.map((session) => session.id)).toEqual(["s-orchestra", "s-food"]);
    expect(cases[0]!.questions.length).toBe(1);
  });

  test("session text renders role-prefixed turns and zips haystack dates", () => {
    const orchestra = cases[0]!.sessions[0]!;
    expect(orchestra.date).toBe("2023/05/01 (Mon) 09:00");
    expect(orchestra.text).toBe(
      "user: I play the cello in an amateur orchestra on weekends.\n" +
        "assistant: That sounds wonderful — how long have you played?",
    );
    expect(orchestra.entities).toEqual(["2023/05/01 (Mon) 09:00"]);
  });

  test("evidence comes from answer_session_ids", () => {
    expect(cases[0]!.questions[0]!.evidenceSessionIds).toEqual(["s-orchestra"]);
  });

  test("knowledge-update type is categorized and keeps the evidence chain in haystack order", () => {
    const update = cases[1]!.questions[0]!;
    expect(update.category).toBe("knowledge-update");
    expect(update.evidenceSessionIds).toEqual(["s-old-job", "s-new-job"]);
  });

  test("_abs question ids are categorized abstention with no evidence", () => {
    const abstention = cases[2]!.questions[0]!;
    expect(abstention.category).toBe("abstention");
    expect(abstention.evidenceSessionIds).toEqual([]);
  });

  test("mismatched haystack ids and sessions throw NormalizeError", () => {
    expect(() =>
      parseLongmemevalS([
        {
          question_id: "broken",
          question_type: "single-session-user",
          question: "?",
          haystack_session_ids: ["a", "b"],
          haystack_sessions: [[]],
          answer_session_ids: [],
        },
      ]),
    ).toThrow(NormalizeError);
  });
});

describe("parseDataset", () => {
  test("dispatches by dataset id", () => {
    expect(parseDataset("locomo", readFixture("locomo-mini.json"))[0]!.id).toBe("conv-1");
    expect(parseDataset("longmemeval-s", readFixture("longmemeval-s-mini.json"))[0]!.id).toBe("q-standard-1");
  });
});
