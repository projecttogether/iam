import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupConnection, ProfileDetail } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { ProfileFormPage } from "./profile-form-page";

afterEach(() => vi.unstubAllGlobals());

const connections: GroupConnection[] = [
  {
    id: 1,
    name: "Keycloak",
    enabled: true,
    mode: "automatic",
    groupLabel: "Groups",
    supportsGroups: true,
    groups: [
      { id: 11, label: "staff" },
      { id: 12, label: "admins" },
    ],
  },
  {
    id: 2,
    name: "Figma",
    enabled: false,
    mode: "manual",
    groupLabel: "Teams",
    supportsGroups: true,
    groups: [],
  },
];

describe("access profile form", () => {
  it("sends the defaults and the grants with their groups", async () => {
    const fetch = stubApi({
      "GET /group-connections": { body: connections },
      "POST /profiles": {
        status: 201,
        body: { id: 5, message: "Saved Staff. Start access updates for its people to apply changes." },
      },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<ProfileFormPage />);
    await user.type(await screen.findByLabelText("Name"), "Staff");
    expect(
      screen.getByText("People of these types get this profile when they are added without one."),
    ).toBeVisible();
    // Beside each connection its mode, "turned off · " first when it is off.
    expect(screen.getByText("Automatic")).toBeVisible();
    expect(screen.getByText("turned off · Manual")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Employee" }));
    // The account and its groups are independent: a group alone grants nothing,
    // and unchecking the account keeps its groups chosen.
    const keycloak = screen.getByRole("checkbox", { name: "Account in Keycloak" });
    await user.click(screen.getByRole("checkbox", { name: "admins" }));
    expect(keycloak).not.toBeChecked();
    await user.click(keycloak);
    await user.click(keycloak);
    expect(screen.getByRole("checkbox", { name: "admins" })).toBeChecked();
    await user.click(keycloak);
    await user.click(screen.getByRole("checkbox", { name: "Account in Figma" }));
    expect(screen.getByText("No teams imported yet.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/5"));
    expect(requests(fetch, "POST /profiles")[0]!.body).toEqual({
      name: "Staff",
      description: "",
      defaultFor: ["employee"],
      grants: [
        { connectionId: 1, groupIds: [12] },
        { connectionId: 2, groupIds: [] },
      ],
    });
  });

  it("grants nothing for groups of an unchecked account", async () => {
    const fetch = stubApi({
      "GET /group-connections": { body: connections },
      "POST /profiles": { status: 201, body: { id: 6, message: "Saved Groups only." } },
    });
    const user = userEvent.setup();
    renderPage(<ProfileFormPage />);
    await user.type(await screen.findByLabelText("Name"), "Groups only");
    await user.click(screen.getByRole("checkbox", { name: "staff" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "POST /profiles")).toHaveLength(1));
    expect(requests(fetch, "POST /profiles")[0]!.body).toMatchObject({ grants: [] });
  });

  it("drops a grant that is unchecked and a group no longer listed", async () => {
    const profile: ProfileDetail = {
      id: 5,
      name: "Staff",
      description: "Everyone employed.",
      defaultFor: ["employee"],
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
      people: [],
    };
    const fetch = stubApi({
      "GET /profiles/5": { body: profile },
      "GET /group-connections": { body: connections },
      "PUT /profiles/5": {
        body: { id: 5, message: "Saved Staff. Start access updates for its people to apply changes." },
      },
    });
    const user = userEvent.setup();
    renderPage(<ProfileFormPage id={5} />);
    expect(await screen.findByRole("heading", { name: "Edit Staff" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "staff" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Account in Figma" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "PUT /profiles/5")).toHaveLength(1));
    expect(requests(fetch, "PUT /profiles/5")[0]!.body).toEqual({
      name: "Staff",
      description: "Everyone employed.",
      defaultFor: ["employee"],
      grants: [{ connectionId: 1, groupIds: [11] }],
    });
  });

  it("shows the server's message for a default another profile has", async () => {
    stubApi({
      "GET /group-connections": { body: connections },
      "POST /profiles": {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Check the highlighted fields",
            fields: { defaultFor: "Contractors is already the default for Freelancer." },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderPage(<ProfileFormPage />);
    await user.type(await screen.findByLabelText("Name"), "Freelancers");
    await user.click(screen.getByRole("checkbox", { name: "Freelancer" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Contractors is already the default for Freelancer.")).toBeVisible();
  });
});
