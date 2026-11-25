import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, ProfileDetail } from "@iam/shared/api/iam";
import { renderPage, stubApi } from "@/test-utils";
import { ProfilePage } from "./profile-page";

afterEach(() => vi.unstubAllGlobals());

const viewer: Me = {
  id: 2,
  email: "viewer@example.invalid",
  name: "Viewer",
  role: "viewer",
  isAdmin: false,
  isApprover: false,
  organizationName: "Example",
  accountUrl: "",
  readOnly: false,
  version: "",
  counts: { openTasks: 0, failedJobs: 0, heldJobs: 0, openRequests: 0 },
};

const profile: ProfileDetail = {
  id: 5,
  name: "Staff",
  description: "Everyone employed.",
  defaultFor: ["employee", "intern"],
  grants: [
    {
      connection: { id: 1, name: "Keycloak", enabled: true },
      groups: [
        { id: 11, label: "staff", missing: false },
        { id: 99, label: "old", missing: true },
      ],
    },
    { connection: { id: 2, name: "Figma", enabled: false }, groups: [] },
  ],
  people: [{ id: 7, name: "Ada Lovelace", status: "active", team: "Product" }],
};

describe("access profile page", () => {
  it("marks a connection that is off and a group no longer listed", async () => {
    stubApi({ "GET /me": { body: viewer }, "GET /profiles/5": { body: profile } });
    renderPage(<ProfilePage id={5} />);
    expect(await screen.findByRole("heading", { name: "Staff" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Grants" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "People" })).toBeVisible();
    expect(screen.getByText("Default for: Employee, Intern")).toBeVisible();
    const [keycloak, figma] = screen.getAllByRole("row");
    expect(keycloak).toHaveTextContent("Keycloak");
    expect(keycloak).not.toHaveTextContent("off");
    expect(keycloak).toHaveTextContent("staff, old missing");
    expect(figma).toHaveTextContent("Figma offAccount only");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
