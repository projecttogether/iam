import { describe, expect, it } from "vitest";
import { safeNext } from "./sign-in";

describe("the page after sign-in", () => {
  it.each([
    ["/people?q=ada", "/people?q=ada"],
    ["/.//evil.example.invalid", "/"],
    ["/./\\evil.example.invalid", "/"],
    ["//evil.example.invalid", "/"],
    ["https://evil.example.invalid/", "/"],
    ["/\\evil.example.invalid", "/"],
    ["people", "/"],
    [undefined, "/"],
  ])("takes %s as %s", (value, expected) => {
    expect(safeNext(value)).toBe(expected);
  });
});
