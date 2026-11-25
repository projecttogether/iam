import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { AppLayout } from "./app-layout";

afterEach(() => vi.unstubAllGlobals());

const admin = {
  ...me("admin"),
  name: "Ada Admin",
  version: "0123456789ab",
  accountUrl: "https://sso.example.invalid/realms/example/account/",
};

describe("app frame", () => {
  it("shows no version and no account link in the frame", async () => {
    stubApi({ "GET /me": { body: admin } });
    renderPage(<AppLayout />);
    const home = await screen.findByRole("link", { name: /^Example/ });
    expect(home).toHaveTextContent("IAM");
    expect(home).not.toHaveTextContent("0123456789ab");
    expect(screen.queryByText(/0123456789ab/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My account" })).not.toBeInTheDocument();
  });

  it("shows the organization that makes the app at the bottom of the sidebar", async () => {
    stubApi({ "GET /me": { body: admin } });
    renderPage(<AppLayout />);
    expect(await screen.findByText("ProjectTogether")).toBeInTheDocument();
  });

  it("offers Settings in the user menu", async () => {
    stubApi({ "GET /me": { body: admin } });
    const user = userEvent.setup();
    renderPage(<AppLayout />);
    await user.click(await screen.findByRole("button", { name: /^Ada Admin/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeVisible();
  });
});
