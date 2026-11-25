import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { people, workflows } from "../db/schema";
import { addDays, today } from "../core/time";
import { LifecycleError, startWorkflow } from "./lifecycle";
import { standardSetup, useEngineFixtures } from "../test/fixtures";

describe("automatic onboarding", () => {
  useEngineFixtures();

  it("starts only while it is still due, with the start date the lock saw", async () => {
    const { person } = await standardSetup();
    await getDb()
      .update(people)
      .set({ startDate: addDays(today(), 3) })
      .where(eq(people.id, person.id));
    // An approver cancelled an onboarding after the schedule chose the person.
    await getDb().update(people).set({ onboardingPaused: true }).where(eq(people.id, person.id));
    await expect(startWorkflow(person.id, "onboarding", { automatic: true })).rejects.toThrow(LifecycleError);
    // The start date moved past the lead time.
    await getDb()
      .update(people)
      .set({ onboardingPaused: false, startDate: addDays(today(), 30) })
      .where(eq(people.id, person.id));
    await expect(startWorkflow(person.id, "onboarding", { automatic: true })).rejects.toThrow(
      "Onboarding is no longer due.",
    );
    expect(await getDb().select().from(workflows)).toHaveLength(0);
    const start = addDays(today(), 2);
    await getDb().update(people).set({ startDate: start }).where(eq(people.id, person.id));
    const workflow = await startWorkflow(person.id, "onboarding", { automatic: true, reason: "stale" });
    const [year, month, day] = start.split("-");
    expect(workflow.reason).toBe(`starts on ${day}.${month}.${year}`);
  });
});
