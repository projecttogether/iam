import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityRequestDetail, Me, PersonOptions } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { RequestPage } from "./request-page";
import { ApproveRequestPage } from "./approve-page";

const user = vi.hoisted(() => ({ current: null as Me | null }));
vi.mock("@/hooks/use-me", () => ({ useMe: () => user.current }));

afterEach(() => vi.unstubAllGlobals());

function identityRequest(overrides: Partial<IdentityRequestDetail> = {}): IdentityRequestDetail {
  return {
    id: 5,
    name: "Grace Hopper",
    personType: "intern",
    status: "open",
    startDate: "2027-01-04",
    requestedBy: "Hanna HR",
    createdAt: "2026-11-23T09:00:00.000Z",
    person: null,
    firstName: "Grace",
    lastName: "Hopper",
    personalEmail: "grace@personal.example.invalid",
    jobTitle: "Research intern",
    team: { id: 3, name: "Research" },
    managerEmail: "ada@example.invalid",
    manager: { id: 7, name: "Ada Lovelace" },
    endDate: null,
    notes: "Needs a laptop.",
    requestedByName: "Hanna HR",
    requestedByEmail: "hanna@example.invalid",
    externalId: "HD-42",
    externalUrl: "https://helpdesk.example.invalid/tickets/42",
    source: "Helpdesk",
    decidedAt: null,
    decidedBy: null,
    decisionNote: "",
    matches: [],
    duplicates: [],
    ...overrides,
  };
}

const options: PersonOptions = {
  teams: [{ id: 3, name: "Research" }],
  profiles: [{ id: 2, name: "Interns", defaultFor: ["intern"] }],
  managers: [{ id: 7, name: "Ada Lovelace" }],
};

describe("identity request page", () => {
  it("rejects an open request with the reason", async () => {
    user.current = me("approver");
    const fetch = stubApi({
      "GET /identity-requests/5": [
        { body: identityRequest() },
        {
          body: identityRequest({
            status: "rejected",
            decidedAt: "2026-11-23T10:00:00.000Z",
            decidedBy: "approver",
            decisionNote: "No contract yet.",
          }),
        },
      ],
      "POST /identity-requests/5/reject": { body: { id: 5, message: "Rejected the request." } },
    });
    const click = userEvent.setup();
    renderPage(<RequestPage id={5} />);
    expect(await screen.findByText("Needs a laptop.")).toBeVisible();
    expect(screen.getByRole("link", { name: "HD-42" })).toHaveAttribute(
      "href",
      "https://helpdesk.example.invalid/tickets/42",
    );
    const reject = screen.getByRole("button", { name: "Reject request" });
    expect(reject).toBeDisabled();
    await click.type(screen.getByLabelText("Reason for rejecting"), "No contract yet.");
    await click.click(reject);
    await waitFor(() => expect(requests(fetch, "POST /identity-requests/5/reject")).toHaveLength(1));
    expect(requests(fetch, "POST /identity-requests/5/reject")[0]!.body).toEqual({
      reason: "No contract yet.",
    });
    expect(await screen.findByRole("heading", { name: "Decision" })).toBeVisible();
    expect(screen.getByText("No contract yet.")).toBeVisible();
  });

  it("links a possible match after asking", async () => {
    user.current = me("approver");
    const fetch = stubApi({
      "GET /identity-requests/5": {
        body: identityRequest({
          matches: [
            {
              id: 9,
              name: "Grace B. Hopper",
              status: "offboarded",
              workEmail: "grace@example.invalid",
              reason: "Same personal email",
            },
          ],
        }),
      },
      "POST /identity-requests/5/link": { body: { id: 9, message: "Linked the request to the person." } },
    });
    const click = userEvent.setup();
    renderPage(<RequestPage id={5} />);
    const row = (await screen.findByRole("link", { name: "Grace B. Hopper" })).closest("tr")!;
    await click.click(within(row).getByRole("button", { name: "Link" }));
    await click.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(requests(fetch, "POST /identity-requests/5/link")).toHaveLength(1));
    expect(requests(fetch, "POST /identity-requests/5/link")[0]!.body).toEqual({ personId: 9 });
  });

  it("finds and links someone the suggestions miss, archived people too", async () => {
    user.current = me("approver");
    const fetch = stubApi({
      "GET /identity-requests/5": { body: identityRequest() },
      "GET /people": {
        body: {
          items: [
            {
              id: 7,
              name: "Grace Brewster",
              workEmail: "gb@example.invalid",
              personType: "intern",
              status: "archived",
              team: null,
              accessProfile: null,
              startDate: null,
              endDate: null,
            },
          ],
          page: 1,
          pages: 1,
          total: 1,
        },
      },
      "POST /identity-requests/5/link": { body: { id: 7, message: "Linked the request to the person." } },
    });
    const click = userEvent.setup();
    renderPage(<RequestPage id={5} />);
    expect(await screen.findByText("No one here has the same name or email.")).toBeVisible();
    await click.type(screen.getByLabelText("Find another person"), "Grace Brewster");
    await click.click(screen.getByRole("button", { name: "Find" }));
    const row = (await screen.findByRole("link", { name: "Grace Brewster" })).closest("tr")!;
    expect(within(row).getByText("gb@example.invalid")).toBeVisible();
    await click.click(within(row).getByRole("button", { name: "Link" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Link the request to Grace Brewster (gb@example.invalid)?"),
    ).toBeVisible();
    await click.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(requests(fetch, "POST /identity-requests/5/link")).toHaveLength(1));
    expect(requests(fetch, "POST /identity-requests/5/link")[0]!.body).toEqual({ personId: 7 });
    expect(requests(fetch, "GET /people")[0]!.url).toContain("q=Grace+Brewster");
  });

  it("points out other requests that may be for the same person", async () => {
    user.current = me("approver");
    stubApi({
      "GET /identity-requests/5": {
        body: identityRequest({
          duplicates: [
            {
              id: 4,
              name: "Grace Hopper",
              status: "open",
              source: "Helpdesk",
              createdAt: "2026-11-22T09:00:00.000Z",
              reason: "Same personal email",
            },
          ],
        }),
      },
      "GET /people/options": { body: options },
    });
    renderPage(<RequestPage id={5} />);
    const section = (await screen.findByRole("heading", { name: "Possible duplicate requests" })).closest(
      "[data-slot=card]",
    ) as HTMLElement;
    expect(within(section).getByRole("link", { name: "Grace Hopper" })).toHaveAttribute(
      "href",
      "/requests/4",
    );
    expect(within(section).getByText("Same personal email")).toBeVisible();
  });

  it("shows a viewer the request without the decision", async () => {
    user.current = me("viewer");
    stubApi({ "GET /identity-requests/5": { body: identityRequest() } });
    renderPage(<RequestPage id={5} />);
    expect(await screen.findByRole("heading", { name: "Requested" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Decide" })).not.toBeInTheDocument();
  });
});

describe("approve page", () => {
  it("prefills the person form from the request and approves it on save", async () => {
    user.current = me("approver");
    const fetch = stubApi({
      "GET /identity-requests/5": { body: identityRequest() },
      "GET /people/options": { body: options },
      "POST /identity-requests/5/approve": { body: { id: 12, message: "Added Grace Hopper." } },
    });
    const click = userEvent.setup();
    renderPage(<ApproveRequestPage id={5} />);
    expect(await screen.findByLabelText(/First name/)).toHaveValue("Grace");
    expect(screen.getByLabelText("Team")).toHaveValue("3");
    expect(screen.getByLabelText("Manager")).toHaveValue("7");
    await click.type(screen.getByLabelText("Work email"), "grace@example.invalid");
    await click.click(screen.getByRole("button", { name: "Add person and approve" }));
    await waitFor(() => expect(requests(fetch, "POST /identity-requests/5/approve")).toHaveLength(1));
    expect(requests(fetch, "POST /identity-requests/5/approve")[0]!.body).toMatchObject({
      firstName: "Grace",
      lastName: "Hopper",
      workEmail: "grace@example.invalid",
      personalEmail: "grace@personal.example.invalid",
      personType: "intern",
      teamId: 3,
      managerId: 7,
      startDate: "2027-01-04",
      notes:
        "Identity request HD-42 from Hanna HR (https://helpdesk.example.invalid/tickets/42).\n\nNeeds a laptop.",
    });
    expect(await screen.findByText("At /people/12")).toBeVisible();
  });
});
