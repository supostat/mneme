import { describe, expect, test } from "bun:test";
import { evaluateConverge } from "./converge";

describe("evaluateConverge happy path", () => {
  test("a unanimous K=N vote passes", () => {
    expect(evaluateConverge(["pass", "pass", "pass"], 3)).toBe(true);
  });

  test("two of three passing with minAgree two passes", () => {
    expect(evaluateConverge(["pass", "pass", "fail"], 2)).toBe(true);
  });

  test("a single passing vote with minAgree one passes", () => {
    expect(evaluateConverge(["pass"], 1)).toBe(true);
  });
});

describe("evaluateConverge threshold edges", () => {
  test("one failing vote under a K=N threshold fails", () => {
    expect(evaluateConverge(["pass", "pass", "fail"], 3)).toBe(false);
  });

  test("a minAgree greater than the vote count fails", () => {
    expect(evaluateConverge(["pass", "pass"], 3)).toBe(false);
  });

  test("an empty vote array with minAgree one fails", () => {
    expect(evaluateConverge([], 1)).toBe(false);
  });
});

describe("evaluateConverge fail-closed on invalid thresholds", () => {
  test("minAgree zero fails even with all passing votes", () => {
    expect(evaluateConverge(["pass", "pass"], 0)).toBe(false);
  });

  test("a negative minAgree fails even with all passing votes", () => {
    expect(evaluateConverge(["pass", "pass"], -1)).toBe(false);
  });

  test("a fractional minAgree fails even with all passing votes", () => {
    expect(evaluateConverge(["pass", "pass"], 1.5)).toBe(false);
  });

  test("a NaN minAgree fails even with all passing votes", () => {
    expect(evaluateConverge(["pass", "pass"], Number.NaN)).toBe(false);
  });
});
