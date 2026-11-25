import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureResult, externalAccount } from "../adapters/base";
import { getDb } from "../db/client";
import { accounts, connections, jobs, tasks, type Account } from "../db/schema";
import { STORE, type FakeAccount } from "../test/fake-adapter";
import { makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { recordJobResult } from "./accounts";
import { completeTask, loadJob } from "./jobs";
import { startWorkflow } from "./lifecycle";
import { compareAccounts } from "./sync";

/** Port of tests/test_accounts.py. */

function listed(values: Pick<FakeAccount, "username" | "email">): FakeAccount {
  return { active: true, groups: new Set(), ...values };
}

async function accountOf(personId: number): Promise<Account> {
  const [account] = await getDb().select().from(accounts).where(eq(accounts.personId, personId));
  return account!;
}

describe("accounts", () => {
  useEngineFixtures();

  it("keeps the groups a manual change applied when a comparison finds the account", async () => {
    const { connection, person } = await standardSetup();
    const approver = await makeUser("approver");
    await getDb().update(connections).set({ mode: "manual" }).where(eq(connections.id, connection.id));
    const workflow = await startWorkflow(person.id, "onboarding");
    const [task] = await getDb()
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(jobs, eq(jobs.id, tasks.jobId))
      .where(eq(jobs.workflowId, workflow.id));
    await completeTask(task!.id, { actor: approver });
    expect((await accountOf(person.id)).appliedGroups).toEqual(["g-eng", "g-staff"]);
    // Someone created the account by hand; the comparison finds it.
    STORE.accounts.set("x1", listed({ username: "ada", email: "ada@example.invalid" }));
    await compareAccounts(connection);
    const account = await accountOf(person.id);
    expect(account.externalId).toBe("x1");
    expect(account.appliedGroups).toEqual(["g-eng", "g-staff"]);
  });

  it("keeps values the app does not report", async () => {
    const { connection, person } = await standardSetup();
    STORE.accounts.set("x1", listed({ username: "ada", email: "ada@example.invalid" }));
    await compareAccounts(connection);
    STORE.accounts.get("x1")!.email = "";
    await compareAccounts(connection);
    const [account] = await getDb().select().from(accounts).where(eq(accounts.externalId, "x1"));
    expect(account!.personId).toBe(person.id);
    expect(account!.email).toBe("ada@example.invalid");
  });

  it("keeps the values of job results within their columns", async () => {
    const { person } = await standardSetup();
    const workflow = await startWorkflow(person.id, "onboarding");
    const [row] = await getDb().select().from(jobs).where(eq(jobs.workflowId, workflow.id));
    const job = (await loadJob(row!.id))!;
    const long = "a".repeat(300);
    const external = externalAccount("x1", { username: long, email: long, displayName: long });
    await recordJobResult(job, ensureResult(external, { created: true }));
    const account = await accountOf(person.id);
    expect(new Set([account.username.length, account.email.length, account.displayName.length])).toEqual(
      new Set([255]),
    );
  });
});
