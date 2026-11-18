import { describe, expect, test } from "bun:test";
import { singleLine } from "./single-line";

describe("singleLine", () => {
  test("every control character and line separator becomes one space, ends trimmed", () => {
    expect(singleLine("\ta\r\nb\u0085c\u2028d\u2029e\u0000f  g ")).toBe("a b c d e f g");
  });
});
