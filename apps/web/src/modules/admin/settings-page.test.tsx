import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { SettingsPage } from "./settings-page";

afterEach(() => vi.unstubAllGlobals());

const settings: Settings = {
  organizationName: "Example",
  automaticOnboarding: true,
  onboardingLeadDays: 7,
  automaticOffboarding: true,
  removalLimitPerDay: 5,
  notificationEmails: "",
  identityRequestTypes: ["employee"],
};

function renderSettings() {
  return renderPage(<SettingsPage />);
}

describe("settings", () => {
  it("reads the counts as Django's IntegerField does", async () => {
    const fetch = stubApi({
      "GET /settings": { body: settings },
      "PUT /settings": { body: { ...settings, onboardingLeadDays: 10, message: "Saved the settings." } },
    });
    const user = userEvent.setup();
    renderSettings();
    const leadDays = await screen.findByLabelText("Onboarding lead days");
    const limit = screen.getByLabelText("Removal limit per day");
    await user.clear(leadDays);
    await user.type(leadDays, "1e2");
    await user.clear(limit);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(leadDays).toHaveAccessibleDescription(/Enter a whole number\./));
    expect(limit).toHaveAccessibleDescription(/This field is required\./);
    expect(requests(fetch, "PUT /settings")).toHaveLength(0);
    // A trailing ".0" means the whole number.
    await user.clear(leadDays);
    await user.type(leadDays, "10.0");
    await user.type(limit, "3");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved the settings.")).toBeVisible();
    expect(requests(fetch, "PUT /settings")[0]!.body).toMatchObject({
      onboardingLeadDays: 10,
      removalLimitPerDay: 3,
    });
  });

  it("chooses the person types other apps may request", async () => {
    const fetch = stubApi({
      "GET /settings": { body: settings },
      "PUT /settings": { body: { ...settings, identityRequestTypes: ["volunteer"], message: "Saved." } },
    });
    const user = userEvent.setup();
    renderSettings();
    const employee = await screen.findByRole("checkbox", { name: "Employee" });
    expect(employee).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Volunteer" }));
    await user.click(employee);
    await user.click(screen.getByRole("button", { name: "Save" }));
    // (The toast of the test before stays in sonner's store: wait for the request instead.)
    await waitFor(() => expect(requests(fetch, "PUT /settings")).toHaveLength(1));
    expect(requests(fetch, "PUT /settings")[0]!.body).toMatchObject({ identityRequestTypes: ["volunteer"] });
  });
});
