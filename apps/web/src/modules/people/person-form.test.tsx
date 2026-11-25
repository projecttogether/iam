import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage, requests, stubApi } from "@/test-utils";
import { personDetail, personOptions } from "./fixtures";
import { PersonForm } from "./person-form";

afterEach(() => vi.unstubAllGlobals());

describe("person form", () => {
  it("shows the server's field messages under their fields (422)", async () => {
    stubApi({
      "POST /people": {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Check the fields",
            fields: { workEmail: "Person with this Work email already exists." },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderPage(<PersonForm options={personOptions} />);
    await user.type(await screen.findByLabelText(/First name/), "Ada");
    await user.type(screen.getByLabelText(/Last name/), "Lovelace");
    await user.type(screen.getByLabelText("Work email"), "ada@example.invalid");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const field = await screen.findByLabelText("Work email");
    await waitFor(() =>
      expect(field).toHaveAccessibleDescription("Person with this Work email already exists."),
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("checks required fields before sending", async () => {
    const fetch = stubApi({});
    const user = userEvent.setup();
    renderPage(<PersonForm options={personOptions} />);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByLabelText(/First name/)).toHaveAccessibleDescription("This field is required.");
    expect(requests(fetch, "POST /people")).toHaveLength(0);
  });

  it("saves the whole person, then shows the person's page with the message", async () => {
    const fetch = stubApi({
      "PUT /people/7": { body: { id: 7, message: "Saved Ada Lovelace.", info: false } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<PersonForm person={personDetail()} options={personOptions} />);
    await user.selectOptions(await screen.findByLabelText("Manager"), "Grace Hopper");
    await user.type(screen.getByLabelText("End date"), "2027-03-31");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/people/7"));
    expect(await screen.findByText("Saved Ada Lovelace.")).toBeVisible();
    expect(requests(fetch, "PUT /people/7")[0]!.body).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      workEmail: "ada@example.invalid",
      personalEmail: "",
      username: "",
      jobTitle: "Engineer",
      personType: "employee",
      teamId: 3,
      managerId: 9,
      accessProfileId: 2,
      startDate: "2026-12-01",
      endDate: "2027-03-31",
      notes: "",
    });
  });
});
