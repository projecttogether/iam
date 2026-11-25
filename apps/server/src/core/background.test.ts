import { afterEach, describe, expect, it, vi } from "vitest";
import { onCommit } from "../db/tx";
import { logger } from "../logger";
import { runInBackground, settleBackground } from "./background";

afterEach(() => vi.restoreAllMocks());

const later = (ms: number, then: () => void = () => undefined) =>
  new Promise<void>((resolve) =>
    setTimeout(() => {
      then();
      resolve();
    }, ms),
  );

describe("background work", () => {
  it("lets a stop wait for it, also for work that starts meanwhile", async () => {
    const done: string[] = [];
    runInBackground(() =>
      later(20, () => {
        done.push("first");
        runInBackground(() => later(20, () => done.push("second")));
      }),
    );
    expect(await settleBackground(5_000)).toBe(0);
    expect(done).toEqual(["first", "second"]);
  });

  it("waits at most the given time, and says how much is still running", async () => {
    runInBackground(() => later(300));
    expect(await settleBackground(20)).toBe(1);
    expect(await settleBackground(5_000)).toBe(0);
  });

  it("logs a failure instead of throwing it", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    runInBackground(() => Promise.reject(new Error("mail server down")), "email failed");
    expect(await settleBackground(1_000)).toBe(0);
    expect(error).toHaveBeenCalledWith({ err: expect.any(Error) }, "email failed");
  });

  it("covers what runs after a commit outside a transaction", async () => {
    const done: string[] = [];
    onCommit(() => later(20, () => done.push("sent")));
    expect(await settleBackground(5_000)).toBe(0);
    expect(done).toEqual(["sent"]);
  });
});
