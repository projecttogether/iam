import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dashboard, Me } from "@iam/shared/api/iam";
import { renderPage, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { DashboardPage } from "./dashboard-page";

const user = vi.hoisted(() => ({ current: null as Me | null }));
vi.mock("@/hooks/use-me", () => ({ useMe: () => user.current }));

afterEach(() => vi.unstubAllGlobals());

const dashboard: Dashboard = {
  peopleCounts: { planned: 2, onboarding: 0, active: 5, offboarding: 0, offboarded: 0, archived: 0 },
  openTasks: 1,
  failedJobs: 3,
  heldJobs: 0,
  openWorkflows: 1,
  connections: 1,
  connectionErrors: [],
  starting: [],
  leaving: [],
  recentEvents: [],
  worker: { stale: false, beatAt: null, maxAgeSeconds: 120 },
};

describe("dashboard", () => {
  it("links each count to its list with the list's filter, under section headings", async () => {
    user.current = me("viewer");
    stubApi({ "GET /dashboard": { body: dashboard } });
    renderPage(<DashboardPage />);
    expect(await screen.findByRole("link", { name: /Failed jobs/ })).toHaveAttribute(
      "href",
      "/jobs?status=failed",
    );
    expect(screen.getByRole("link", { name: /Removals to approve/ })).toHaveAttribute(
      "href",
      "/jobs?status=held",
    );
    expect(screen.getByRole("link", { name: /Active people/ })).toHaveAttribute(
      "href",
      "/people?status=active",
    );
    expect(screen.getByRole("link", { name: /Open tasks/ })).toHaveAttribute("href", "/tasks");
    for (const name of ["Starting in the next 30 days", "Leaving in the next 30 days", "Recent activity"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });
});
