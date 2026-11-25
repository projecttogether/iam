import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { PreferencesPage } from "./preferences-page";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

const ACCOUNT_URL = "https://sso.example.invalid/realms/example/account/";

describe("my settings", () => {
  it("links to the sign-in provider's account page", async () => {
    stubApi({
      "GET /me": { body: { ...me("viewer"), accountUrl: ACCOUNT_URL } },
    });
    renderPage(<PreferencesPage />);
    expect(await screen.findByRole("link", { name: "Manage account" })).toHaveAttribute("href", ACCOUNT_URL);
    expect(screen.getByText(/two-step sign-in at the sign-in provider/)).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("switch")).toBeChecked();
  });

  it("has no account card without an account page", async () => {
    stubApi({ "GET /me": { body: me("viewer") } });
    renderPage(<PreferencesPage />);
    expect(await screen.findByRole("radiogroup", { name: "Appearance" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Manage account" })).not.toBeInTheDocument();
    expect(screen.queryByText("Account")).not.toBeInTheDocument();
  });

  it("keeps the appearance in this browser", async () => {
    stubApi({ "GET /me": { body: me("viewer") } });
    const user = userEvent.setup();
    renderPage(<PreferencesPage />);
    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem("iam.theme")).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("shows the version, linked to its commit, and the source code", async () => {
    stubApi({ "GET /me": { body: { ...me("viewer"), version: "0123456789ab" } } });
    renderPage(<PreferencesPage />);
    expect(await screen.findByRole("link", { name: "Version 0123456789ab" })).toHaveAttribute(
      "href",
      "https://github.com/projecttogether/iam/commit/0123456789ab",
    );
    expect(screen.getByText(/open-source app for identity and access management/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Source code on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/projecttogether/iam",
    );
  });

  it("says so when the build has no version", async () => {
    stubApi({ "GET /me": { body: { ...me("viewer"), version: "" } } });
    renderPage(<PreferencesPage />);
    expect(await screen.findByText("Built from source, without a version")).toBeVisible();
  });
});
