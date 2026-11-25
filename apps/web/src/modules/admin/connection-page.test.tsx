import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDetail } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { ConnectionPage } from "./connection-page";

afterEach(() => vi.unstubAllGlobals());

function detail(changes: Partial<ConnectionDetail> = {}): ConnectionDetail {
  return {
    id: 3,
    name: "Slack",
    adapterName: "Slack",
    enabled: true,
    status: "ok",
    mode: "manual",
    kind: "provisioning",
    adapter: {
      slug: "slack",
      name: "Slack",
      kind: "provisioning",
      description: "Tracks Slack members.",
      fields: [],
      hasMode: false,
      supportsWrite: false,
      supportsGroups: true,
      groupLabel: "Channels",
      manualGroups: true,
    },
    statusMessage: "",
    checkedAt: null,
    settings: [{ label: "Workspace URL", kind: "url", value: "https://example.invalid" }],
    secrets: [{ label: "Bot token", saved: true }],
    supportsGroups: true,
    canImportGroups: true,
    canCompare: true,
    syncIntervalMinutes: 60,
    groupsSyncedAt: null,
    groups: [
      { id: 21, label: "general", externalId: "C01", missing: false, manual: false },
      { id: 22, label: "design", externalId: "manual:design", missing: false, manual: true },
    ],
    accounts: [{ id: 31, label: "ada", person: null, status: "active", observedAt: null }],
    accountCount: 1,
    syncRuns: [],
    grants: [{ id: 4, name: "Staff" }],
    deletable: false,
    ...changes,
  };
}

describe("connection page", () => {
  it("shows the actions, settings and secrets without values", async () => {
    stubApi({ "GET /connections/3": { body: detail() } });
    renderPage(<ConnectionPage id={3} />);
    expect(await screen.findByRole("button", { name: "Test connection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Import channels" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Compare accounts now" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeVisible();
    expect(screen.getByText("Bot token").parentElement).toHaveTextContent("saved");
    expect(screen.getByText("not linked")).toBeVisible();
    // Only manual groups can be removed; the connection is in use, so no Delete.
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Delete connection" })).toBeNull();
  });

  it("toasts a failed test as an error and reloads the connection", async () => {
    const fetch = stubApi({
      "GET /connections/3": { body: detail() },
      "POST /connections/3/test": { body: { ok: false, message: "Slack refused the token." } },
    });
    const user = userEvent.setup();
    renderPage(<ConnectionPage id={3} />);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    const toast = await screen.findByText("Slack refused the token.");
    expect(toast.closest("[data-type]")).toHaveAttribute("data-type", "error");
    expect(requests(fetch, "POST /connections/3/test")).toHaveLength(1);
    await waitFor(() => expect(requests(fetch, "GET /connections/3")).toHaveLength(2));
  });

  it("adds a channel by hand and shows a 409 of a removal", async () => {
    const fetch = stubApi({
      "GET /connections/3": { body: detail() },
      "POST /connections/3/groups": { body: { message: "Added random." } },
      "DELETE /connections/3/groups/22": {
        status: 409,
        body: { error: { code: "in_use", message: "design is still used by an access profile or team." } },
      },
    });
    const user = userEvent.setup();
    renderPage(<ConnectionPage id={3} />);
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "random");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Added random.")).toBeVisible();
    expect(requests(fetch, "POST /connections/3/groups")[0]!.body).toEqual({ name: "random" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(""));
    await user.click(screen.getByRole("button", { name: "Remove design" }));
    expect(await screen.findByText("design is still used by an access profile or team.")).toBeVisible();
  });

  it("deletes an unused connection after asking", async () => {
    const fetch = stubApi({
      "GET /connections/3": { body: detail({ deletable: true, grants: [] }) },
      "DELETE /connections/3": { body: { message: "Deleted Slack." } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<ConnectionPage id={3} />);
    await user.click(await screen.findByRole("button", { name: "Delete connection" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(requests(fetch, "DELETE /connections/3")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete connection" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/connections"));
    expect(await screen.findByText("Deleted Slack.")).toBeVisible();
  });
});
