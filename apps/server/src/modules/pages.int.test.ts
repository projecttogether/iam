import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { jobs, tasks } from "../db/schema";
import { startWorkflow } from "../engine/lifecycle";
import { makeUser, standardSetup, useEngineFixtures } from "../test/fixtures";
import { request, signInWithTestHeader } from "../test/helpers";

/**
 * Port of tests/test_views.py: which role reads and changes what. The Django
 * version rendered pages; here each page is the API request its web app page
 * makes. PermissionDenied (403) stays 403.
 */

/** The `world` fixture: Ada's onboarding with its job, a task, and a user per role. */
async function world() {
  const setup = await standardSetup();
  const [viewer, approver, admin] = [
    await makeUser("viewer"),
    await makeUser("approver"),
    await makeUser("admin"),
  ];
  const workflow = await startWorkflow(setup.person.id, "onboarding", { actor: approver });
  const [job] = await getDb().select().from(jobs).where(eq(jobs.workflowId, workflow.id));
  const [task] = await getDb()
    .insert(tasks)
    .values({ kind: "change", title: "Do something", personId: setup.person.id })
    .returning();
  return { ...setup, viewer, approver, admin, workflow, job: job!, task: task! };
}

/** Admin › pages: their reads. Team, profile and user forms load the choices here. */
const ADMIN_READS = [
  "/connections",
  "/adapters",
  "/users",
  "/users/options",
  "/settings",
  "/group-connections",
];

describe("pages and permissions", () => {
  useEngineFixtures();
  let stopTestHeader: () => void;
  beforeAll(() => {
    stopTestHeader = signInWithTestHeader();
  });
  afterAll(() => stopTestHeader());

  it("shows every page to viewers, privately, and keeps admin pages and forms from them", async () => {
    const w = await world();
    const pages = [
      "/dashboard",
      "/people",
      "/people?q=ada&status=onboarding",
      `/people/${w.person.id}`,
      "/teams",
      `/teams/${w.team.id}`,
      "/profiles",
      `/profiles/${w.profile.id}`,
      "/workflows",
      "/workflows?status=all",
      `/workflows/${w.workflow.id}`,
      "/jobs",
      "/jobs?status=all",
      `/jobs/${w.job.id}`,
      "/tasks",
      `/tasks/${w.task.id}`,
      "/audit?q=onboarding",
    ];
    for (const page of pages) {
      const response = await request("GET", `/api/v1${page}`, { user: w.viewer });
      expect(response.status, page).toBe(200);
      expect(response.headers.get("cache-control"), page).toBe("no-store");
      expect(response.headers.get("content-security-policy"), page).toContain("default-src 'self'");
    }
    for (const page of ADMIN_READS) {
      expect((await request("GET", `/api/v1${page}`, { user: w.viewer })).status, page).toBe(403);
    }
    // The create forms: what they save.
    const creates: [string, unknown][] = [
      ["/teams", { name: "Ops", description: "", groupIds: [] }],
      ["/profiles", { name: "Other", description: "", defaultFor: [], grants: [] }],
      [
        "/users",
        { email: "new@example.invalid", displayName: "", role: "viewer", isActive: true, personId: null },
      ],
      [
        "/connections",
        { adapter: "manual", name: "Figma", enabled: false, settings: { app_name: "Figma" }, secrets: {} },
      ],
      ["/people", { firstName: "Grace", lastName: "Hopper", personType: "employee" }],
    ];
    for (const [path, body] of creates) {
      expect((await request("POST", `/api/v1${path}`, { user: w.viewer, body })).status, path).toBe(403);
    }
  });

  it("shows admins the admin pages, and never a saved secret", async () => {
    const w = await world();
    for (const page of ADMIN_READS) {
      expect((await request("GET", `/api/v1${page}`, { user: w.admin })).status, page).toBe(200);
    }
    for (const slug of [
      "keycloak",
      "google_workspace",
      "scim",
      "hubspot",
      "slack",
      "notion",
      "relution",
      "manual",
      "personio",
      "smtp",
    ]) {
      expect((await request("GET", `/api/v1/adapters/${slug}`, { user: w.admin })).status, slug).toBe(200);
    }
    const detail = await request("GET", `/api/v1/connections/${w.connection.id}`, { user: w.admin });
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain("fake-token");
    const form = await request("GET", `/api/v1/connections/${w.connection.id}/form`, { user: w.admin });
    expect(form.status).toBe(200);
    expect(form.text).not.toContain("fake-token");
    expect((await request("GET", `/api/v1/teams/${w.team.id}`, { user: w.admin })).status).toBe(200);
    expect((await request("GET", `/api/v1/profiles/${w.profile.id}`, { user: w.admin })).status).toBe(200);
    expect((await request("GET", `/api/v1/users/${w.admin.id}`, { user: w.admin })).status).toBe(200);
  });

  it("lets viewers change nothing", async () => {
    const w = await world();
    for (const path of [
      `/people/${w.person.id}/start/offboarding`,
      `/tasks/${w.task.id}/complete`,
      `/jobs/${w.job.id}/retry`,
      `/workflows/${w.workflow.id}/cancel`,
    ]) {
      expect((await request("POST", `/api/v1${path}`, { user: w.viewer, body: {} })).status, path).toBe(403);
    }
  });

  it("keeps approvals of removals and connections from approvers", async () => {
    const w = await world();
    expect(
      (await request("POST", `/api/v1/jobs/${w.job.id}/approve`, { user: w.approver, body: {} })).status,
    ).toBe(403);
    expect((await request("GET", "/api/v1/connections", { user: w.approver })).status).toBe(403);
    expect(
      (await request("POST", `/api/v1/connections/${w.connection.id}/test`, { user: w.approver, body: {} }))
        .status,
    ).toBe(403);
  });

  it("ignores a team or connection filter that is no number", async () => {
    const viewer = await makeUser("viewer");
    await standardSetup();
    // "²" is a digit to Python's str.isdigit() but no number to int().
    for (const path of ["/people?team=abc", "/people?team=%C2%B2", "/jobs?connection=%C2%B2"]) {
      expect((await request("GET", `/api/v1${path}`, { user: viewer })).status, path).toBe(200);
    }
  });

  it("allows no inline scripts, while the inline styles of the web app still apply", async () => {
    // The Django test kept style="" out of its templates, which its policy
    // (style-src 'self') would have blocked silently. The web app sets inline
    // styles, so style-src allows them; scripts stay limited to the app's own.
    const response = await request("GET", "/-/healthz");
    const policy = Object.fromEntries(
      response.headers
        .get("content-security-policy")!
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values]),
    );
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["script-src"]).toEqual(["'self'"]);
    expect(policy["style-src"]).toContain("'unsafe-inline'");
  });
});
