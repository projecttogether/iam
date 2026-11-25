import { describe, expect, it } from "vitest";
import { casefold, ReadOnlyError, readOnly } from "./base";
import { ManualAdapter } from "./manual";

describe("casefold", () => {
  it("compares as Python's str.casefold does", () => {
    expect(casefold("STRASSE")).toBe(casefold("straße"));
    expect(casefold("STRAẞE")).toBe("strasse");
    expect(casefold("ﬁle")).toBe(casefold("FILE"));
    expect(casefold("Ada")).toBe("ada");
    // casefold keeps the dotless ı apart from i.
    expect(casefold("ılker")).not.toBe(casefold("ilker"));
  });
});

describe("the read-only wrapper", () => {
  const adapter = () => readOnly(new ManualAdapter({ app_name: "Figma" }));

  it("lets reads through and blocks every change", async () => {
    const wrapped = adapter();
    expect((await wrapped.testConnection()).ok).toBe(true);
    expect(wrapped.label).toBe("Other app (manual tasks)");
    expect(() => wrapped.createAccount).toThrow(ReadOnlyError);
    expect(() => wrapped.addToGroup).toThrow(
      /Read-only mode: Other app \(manual tasks\) was not changed \(add to group\)/,
    );
    expect(() => wrapped.sendMessage).toThrow(ReadOnlyError);
    expect(() => wrapped.ensureAccount).toThrow(ReadOnlyError);
  });

  it("exposes nothing of the adapter beyond its reads", () => {
    const wrapped = adapter();
    expect(() => wrapped.config).toThrow(ReadOnlyError);
    expect(Object.getOwnPropertyDescriptor(wrapped, "config")).toBeUndefined();
    expect(Object.keys(wrapped)).toEqual([]);
    expect(Object.getPrototypeOf(wrapped)).toBeNull();
    expect(() => Object.defineProperty(wrapped, "createAccount", { value: () => undefined })).toThrow(
      ReadOnlyError,
    );
    expect("findAccount" in wrapped).toBe(true);
    expect("createAccount" in wrapped).toBe(false);
  });
});
