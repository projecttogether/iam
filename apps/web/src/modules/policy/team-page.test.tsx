import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, TeamDetail } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { TeamPage } from "./team-page";
import { TeamFormPage } from "./team-form-page";

afterEach(() => vi.unstubAllGlobals());

const me = (isAdmin: boolean): Me => ({
  id: 1,
  email: "admin@example.invalid",
  name: "Admin",
  role: isAdmin ? "admin" : "viewer",
  isAdmin,
  isApprover: isAdmin,
  organizationName: "Example",
  accountUrl: "",
  readOnly: false,
  version: "",
  counts: { openTasks: 0, failedJobs: 0, heldJobs: 0, openRequests: 0 },
});

const team: TeamDetail = {
  id: 2,
  name: "Product",
  description: "Product and design",
  members: [{ id: 7, name: "Ada Lovelace", status: "active", accessProfile: "Staff" }],
  groups: [
    { id: 11, label: "product", connection: "Keycloak", missing: false },
    { id: 12, label: "old", connection: "Keycloak", missing: true },
  ],
  groupIds: [11],
};

describe("team page", () => {
  it("shows no Edit or Delete to a viewer", async () => {
    stubApi({ "GET /me": { body: me(false) }, "GET /teams/2": { body: team } });
    renderPage(<TeamPage id={2} />);
    expect(await screen.findByRole("heading", { name: "Product" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Groups" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Members" })).toBeVisible();
    expect(screen.getByText("Keycloak: product")).not.toHaveTextContent("missing");
    expect(screen.getByText(/Keycloak: old/)).toHaveTextContent("Keycloak: old missing");
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("deletes the team after asking, then opens the list", async () => {
    const fetch = stubApi({
      "GET /me": { body: me(true) },
      "GET /teams/2": { body: team },
      "DELETE /teams/2": { body: { message: "Deleted team Product." } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<TeamPage id={2} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Its members stay, without a team.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/teams"));
    expect(await screen.findByText("Deleted team Product.")).toBeVisible();
    expect(requests(fetch, "DELETE /teams/2")).toHaveLength(1);
  });
});

describe("team form", () => {
  it("sends the chosen groups of the listed connections", async () => {
    const fetch = stubApi({
      "GET /teams/2": { body: { ...team, groupIds: [11, 99] } },
      "GET /group-connections": {
        body: [
          {
            id: 1,
            name: "Keycloak",
            enabled: true,
            mode: "automatic",
            groupLabel: "Groups",
            supportsGroups: true,
            groups: [
              { id: 11, label: "product" },
              { id: 12, label: "staff" },
            ],
          },
          {
            id: 2,
            name: "Slack",
            enabled: false,
            mode: "manual",
            groupLabel: "Channels",
            supportsGroups: true,
            groups: [],
          },
        ],
      },
      "PUT /teams/2": { body: { id: 2, message: "Saved team Product." } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<TeamFormPage id={2} />);
    expect(await screen.findByRole("heading", { name: "Edit Product" })).toBeVisible();
    expect(screen.getByText("No channels imported yet. Import them on the connection page.")).toBeVisible();
    expect(screen.getByText("Channels · turned off")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "staff" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/teams/2"));
    expect(requests(fetch, "PUT /teams/2")[0]!.body).toEqual({
      name: "Product",
      description: "Product and design",
      groupIds: [11, 12],
    });
  });
});
