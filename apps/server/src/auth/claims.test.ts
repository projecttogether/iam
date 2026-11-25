import { afterEach, describe, expect, it } from "vitest";
import { overrideConfigForTests, resetConfigForTests } from "../config";
import { emailVerified, roleFromGroups } from "./claims";

/** Port of tests/test_auth.py: the claims rules that need no database. */

const claims = (extra: Record<string, unknown> = {}) => ({
  sub: "subject-1",
  email: "ada@example.invalid",
  email_verified: true,
  ...extra,
});

describe("claims", () => {
  afterEach(() => resetConfigForTests());

  it.each([[1], [["true"]], [{ verified: true }]])(
    "refuses an email_verified claim of another type (%j)",
    (value) => {
      expect(emailVerified(claims({ email_verified: value }))).toBe(false);
    },
  );

  it("never matches a group of that name further down", () => {
    // Otherwise everyone in any "/team/admins" would become an admin of this app.
    overrideConfigForTests({ adminGroups: ["admins", "/iam/admins"] });
    for (const groups of [["/sales/admins"], ["/sales/iam/admins"], ["/iam/admins/eu"], ["/iam"]]) {
      expect(roleFromGroups(claims({ groups })), String(groups)).toBeNull();
    }
    for (const groups of [["admins"], ["/admins"], ["/iam/admins"]]) {
      expect(roleFromGroups(claims({ groups })), String(groups)).toBe("admin");
    }
  });
});
