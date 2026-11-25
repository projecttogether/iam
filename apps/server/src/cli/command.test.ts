import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isOperator, operator } from "../engine/audit";
import { parseArgs, readJsonBody, run, UsageError, type Io } from "./command";

const SRC = path.resolve(import.meta.dirname, "..");

describe("the operator", () => {
  it("is created only by the command line, never by a route", () => {
    const callers = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => /\boperator\(/.test(readFileSync(path.join(SRC, file), "utf8")))
      .filter((file) => file !== path.join("engine", "audit.ts"));
    expect(
      callers.every((file) => file === "cli.ts" || file.startsWith(`cli${path.sep}`)),
      callers.join(),
    ).toBe(true);
    expect(callers.length).toBeGreaterThan(0);
  });

  it("does not survive JSON, so no request body can stand for it", () => {
    expect(isOperator(operator("cli settings list"))).toBe(true);
    expect(isOperator(JSON.parse(JSON.stringify(operator("cli settings list"))))).toBe(false);
    expect(isOperator({ operator: true, command: "x" })).toBe(false);
  });
});

describe("parseArgs", () => {
  const allowed = { positionals: 1, options: ["--id"], flags: ["--json"] };

  it("reads positionals, options and flags", () => {
    expect(parseArgs(["connections", "--id", "3", "--json"], allowed)).toEqual({
      positionals: ["connections"],
      options: new Map([["--id", "3"]]),
      flags: new Set(["--json"]),
    });
  });

  it.each([
    [["--password", "hunter2-value"]],
    [["--password=hunter2-value"]],
    [["connections", "hunter2-value"]],
    [["--id=hunter2-value"]],
  ])("refuses %j without repeating it", (args) => {
    let error: unknown;
    try {
      parseArgs(args, allowed);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).not.toContain("hunter2");
  });

  it("needs a value after an option", () => {
    expect(() => parseArgs(["--id"], allowed)).toThrow("--id needs a value.");
    expect(() => parseArgs(["--id", "--json"], allowed)).toThrow("--id needs a value.");
  });
});

describe("readJsonBody", () => {
  const io = (text: string): Io => ({ readStdin: async () => text, out: () => {}, err: () => {} });

  it("parses JSON and refuses anything else without quoting it", async () => {
    expect(await readJsonBody(io('{"name": "Email"}'))).toEqual({ name: "Email" });
    await expect(readJsonBody(io("{ hunter2-value"))).rejects.toThrow("The body on stdin must be JSON.");
    await expect(readJsonBody(io(" \n"))).rejects.toBeInstanceOf(UsageError);
  });
});

describe("run", () => {
  async function exit(error: Error) {
    const err: string[] = [];
    const io: Io = { readStdin: async () => "", out: () => {}, err: (text) => void err.push(text) };
    const code = await run(io, async () => {
      throw error;
    });
    return { code, err: err.join("") };
  }

  it("asks to try again after a concurrent change, as the page does", async () => {
    const cause = Object.assign(new Error("duplicate key value"), { code: "23505" });
    expect(await exit(new DrizzleQueryError("insert into iam_apikey", ["hunter2-value"], cause))).toEqual({
      code: 1,
      err: "Someone else changed this at the same time. Try again.\n",
    });
  });

  it("does not print a failed query, which quotes its values", async () => {
    const failed = await exit(
      new DrizzleQueryError("update iam_connection set x = $1", ["hunter2-value"], new Error("boom")),
    );
    expect(failed.code).toBe(1);
    expect(failed.err).not.toContain("hunter2");
  });
});
