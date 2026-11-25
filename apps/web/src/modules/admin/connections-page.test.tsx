import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterInfo, ConnectionRow } from "@iam/shared/api/iam";
import { renderPage, stubApi } from "@/test-utils";
import { ConnectionsPage } from "./connections-page";
import { ChooseAdapterPage } from "./choose-adapter-page";

afterEach(() => vi.unstubAllGlobals());

const row = (changes: Partial<ConnectionRow>): ConnectionRow => ({
  id: 1,
  name: "Keycloak",
  adapterName: "Keycloak",
  enabled: true,
  status: "ok",
  mode: "read_only",
  kind: "provisioning",
  checkedAt: null,
  ...changes,
});

const adapter = (changes: Partial<AdapterInfo>): AdapterInfo => ({
  slug: "keycloak",
  name: "Keycloak",
  kind: "provisioning",
  description: "Creates users in a realm.",
  fields: [],
  hasMode: true,
  supportsWrite: true,
  supportsGroups: true,
  groupLabel: "Groups",
  manualGroups: false,
  ...changes,
});

describe("connections list", () => {
  it("shows each connection's mode, state and last check", async () => {
    stubApi({
      "GET /connections": {
        body: {
          hasConnections: true,
          sections: [
            {
              kind: "provisioning",
              label: "Accounts and groups",
              connections: [
                row({ checkedAt: "2026-11-20T09:30:00Z" }),
                row({ id: 2, name: "Figma", adapterName: "Other app", enabled: false, mode: "manual" }),
              ],
            },
            { kind: "hr_source", label: "People import", connections: [] },
          ],
        },
      },
    });
    renderPage(<ConnectionsPage />);
    const keycloak = (await screen.findByRole("link", { name: "Keycloak" })).closest("tr")!;
    expect(within(keycloak).getByText("Read only")).toBeVisible();
    expect(within(keycloak).getByText("Connected")).toBeVisible();
    expect(within(keycloak).getByText(/Nov 20, 2026/)).toBeVisible();
    const figma = screen.getByRole("link", { name: "Figma" }).closest("tr")!;
    expect(within(figma).getByText("Off")).toBeVisible();
    expect(within(figma).getByText("never")).toBeVisible();
    // A section without connections is left out.
    expect(screen.queryByText("People import")).toBeNull();
  });
});

describe("add connection", () => {
  it("says what an account adapter does, with its groups", async () => {
    stubApi({
      "GET /adapters": {
        body: [
          {
            kind: "provisioning",
            label: "Accounts and groups",
            adapters: [
              adapter({}),
              adapter({
                slug: "manual",
                name: "Other app",
                hasMode: false,
                supportsWrite: false,
                supportsGroups: false,
              }),
            ],
          },
          {
            kind: "email",
            label: "Email",
            adapters: [adapter({ slug: "smtp", name: "Email (SMTP)", kind: "email", supportsGroups: false })],
          },
        ],
      },
    });
    renderPage(<ChooseAdapterPage />);
    expect(await screen.findByRole("link", { name: /Keycloak/ })).toHaveTextContent(
      "Creates and disables accounts · Groups",
    );
    expect(screen.getByRole("link", { name: /Other app/ })).toHaveTextContent("Changes become tasks");
    expect(screen.getByRole("link", { name: /Other app/ })).not.toHaveTextContent("·");
    expect(screen.getByRole("link", { name: /Email \(SMTP\)/ })).not.toHaveTextContent("accounts");
  });
});
