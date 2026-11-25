import { afterEach, beforeEach } from "vitest";
import { recordPauses } from "./mock-fetch";

/** Reads that adapters try again pause without sleeping in tests. */
let restore: (() => void) | undefined;
beforeEach(() => {
  restore = recordPauses().restore;
});
afterEach(() => restore?.());
