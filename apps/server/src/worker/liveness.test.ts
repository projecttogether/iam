import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import { noteProgress, watch } from "./liveness";

/** Port of tests/test_liveness.py. */

/** The last progress `seconds` ago (Python: monkeypatch liveness._last_progress). */
function progressAgo(seconds: number) {
  const now = performance.now();
  const spy = vi.spyOn(performance, "now").mockReturnValue(now - seconds * 1000);
  noteProgress();
  spy.mockRestore();
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iam-liveness-"));
}

describe("the watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    noteProgress();
  });

  it("ends a stuck worker", () => {
    const alive = path.join(tempDir(), "alive");
    const stopped: number[] = [];
    noteProgress();
    expect(watch(60, { aliveFile: alive, stop: (code) => stopped.push(code) })).toBe(true);
    expect(fs.existsSync(alive)).toBe(true);
    expect(stopped).toEqual([]);
    // Back-date the file, so that a touch within the same millisecond would show.
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(alive, past, past);
    const touched = fs.statSync(alive).mtimeMs;
    progressAgo(61);
    expect(watch(60, { aliveFile: alive, stop: (code) => stopped.push(code) })).toBe(false);
    expect(stopped).toEqual([1]);
    expect(fs.statSync(alive).mtimeMs, "a stuck worker no longer looks healthy").toBe(touched);
  });

  it("stops the worker even when its report fails", () => {
    vi.spyOn(logger, "fatal").mockImplementation(() => {
      throw new Error("stderr is gone");
    });
    progressAgo(61);
    const stopped: number[] = [];
    expect(() =>
      watch(60, { aliveFile: path.join(tempDir(), "alive"), stop: (code) => stopped.push(code) }),
    ).toThrow("stderr is gone");
    expect(stopped).toEqual([1]);
  });
});
