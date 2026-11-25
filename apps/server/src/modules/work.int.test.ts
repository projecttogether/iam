import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_STATUS_LABELS } from "@iam/shared/labels";
import { getDb } from "../db/client";
import { jobs, tasks, type JobStatus } from "../db/schema";
import { claimNextJob, runJob } from "../engine/jobs";
import { cancelWorkflow, startWorkflow } from "../engine/lifecycle";
import { grant, makeConnection, makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

/** Port of tests/test_views.py: tasks, job approvals and cancelled workflows. */

describe("work", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("completes a task from its page", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    const [task] = await getDb()
      .insert(tasks)
      .values({ kind: "change", title: "Do something", personId: person.id })
      .returning();
    const response = await request("POST", `/api/v1/tasks/${task!.id}/complete`, {
      user: approver,
      body: { note: "done by hand" },
    });
    expect(response.status).toBe(200);
    const [done] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
    expect(done!.status).toBe("done");
    expect(done!.note).toBe("done by hand");
  });

  it("lets admins approve held jobs", async () => {
    const { person } = await standardSetup();
    const [approver, admin] = [await makeUser("approver"), await makeUser("admin")];
    const workflow = await startWorkflow(person.id, "onboarding", { actor: approver });
    const [job] = await getDb().select().from(jobs).where(eq(jobs.workflowId, workflow.id));
    await getDb().update(jobs).set({ status: "held" }).where(eq(jobs.id, job!.id));
    expect((await request("POST", `/api/v1/jobs/${job!.id}/approve`, { user: admin, body: {} })).status).toBe(
      200,
    );
    const [approved] = await getDb().select().from(jobs).where(eq(jobs.id, job!.id));
    expect(approved!.status).toBe("queued");
  });

  it("never claims that a cancel stopped a job that was already running", async () => {
    const { person } = await standardSetup();
    const approver = await makeUser("approver");
    const workflow = await startWorkflow(person.id, "onboarding");
    const job = (await claimNextJob())!;
    const response = await request("POST", `/api/v1/workflows/${workflow.id}/cancel`, {
      user: approver,
      body: {},
    });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe(
      "Cancelled the workflow. Too late for the job at Fake app: it was already running, so its change goes ahead.",
    );
    // The page says that the workflow was cancelled while jobs ran, and why.
    const page = await request("GET", `/api/v1/workflows/${workflow.id}`, { user: approver });
    expect(page.body.status).toBe("cancelled");
    expect(page.body.tooLate).toBe(
      "Too late for the job at Fake app: it was already running, so its change goes ahead.",
    );

    await runJob(job);
    const jobPage = await request("GET", `/api/v1/jobs/${job.id}`, { user: approver });
    // Shown as "Done", never as "Cancelled".
    expect(JOB_STATUS_LABELS[jobPage.body.status as JobStatus]).toBe("Done");
    expect(jobPage.body.events.map((event: { summary: string }) => event.summary).join("\n")).toContain(
      "too late to stop the change",
    );
  });

  it("names every job a cancel came too late for on the workflow page", async () => {
    const { person, profile } = await standardSetup();
    const approver = await makeUser("approver");
    const wiki = await makeConnection({ name: "Wiki" });
    await grant(profile, wiki);
    const workflow = await startWorkflow(person.id, "onboarding");
    await claimNextJob();
    await claimNextJob();
    await cancelWorkflow(workflow.id, { actor: approver });
    const page = await request("GET", `/api/v1/workflows/${workflow.id}`, { user: approver });
    expect(page.body.tooLate).toBe(
      "Too late for the jobs at Fake app and Wiki: they were already running, so their changes go ahead.",
    );
  });
});
