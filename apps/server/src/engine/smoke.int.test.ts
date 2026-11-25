import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { accounts, jobs, people, workflows } from "../db/schema";
import { claimNextJob, runJob } from "./jobs";
import { startWorkflow } from "./lifecycle";
import { STORE } from "../test/fake-adapter";
import { standardSetup, useEngineFixtures } from "../test/fixtures";

describe("the engine end to end", () => {
  useEngineFixtures();

  it("onboards a person: one job, the account with the groups, the person active", async () => {
    const { person } = await standardSetup();
    const workflow = await startWorkflow(person.id, "onboarding");
    expect(workflow.status).toBe("running");
    const claimed = await claimNextJob();
    expect(claimed).not.toBeNull();
    await runJob(claimed!);
    const [account] = await getDb().select().from(accounts).where(eq(accounts.personId, person.id));
    expect(account!.status).toBe("active");
    expect(account!.appliedGroups).toEqual(["g-eng", "g-staff"]);
    expect([...STORE.accounts.values()][0]!.groups).toEqual(new Set(["g-eng", "g-staff"]));
    const [saved] = await getDb().select().from(workflows).where(eq(workflows.id, workflow.id));
    expect(saved!.status).toBe("completed");
    const [ada] = await getDb().select().from(people).where(eq(people.id, person.id));
    expect(ada!.status).toBe("active");
    const [job] = await getDb().select().from(jobs);
    expect(job!.status).toBe("succeeded");
  });
});
