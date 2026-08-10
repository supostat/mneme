import { describe, expect, test } from "bun:test";
import { evaluateConverge } from "./converge";

describe("evaluateConverge unanimity", () => {
  test("a unanimous vote passes", () => {
    expect(evaluateConverge(["pass", "pass", "pass"])).toBe(true);
  });

  test("a single passing vote passes", () => {
    expect(evaluateConverge(["pass"])).toBe(true);
  });

  test("one failing vote fails the criterion — each vote guards its own axis", () => {
    expect(evaluateConverge(["pass", "pass", "fail"])).toBe(false);
  });

  test("all failing votes fail", () => {
    expect(evaluateConverge(["fail", "fail"])).toBe(false);
  });
});

describe("evaluateConverge fail-closed", () => {
  test("an empty vote array fails — silence is not agreement", () => {
    expect(evaluateConverge([])).toBe(false);
  });
});
