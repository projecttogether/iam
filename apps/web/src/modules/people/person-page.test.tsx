import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { me, personDetail } from "./fixtures";
import { PersonPage } from "./person-page";

const user = vi.hoisted(() => ({ current: null as Me | null }));
vi.mock("@/hooks/use-me", () => ({ useMe: () => user.current }));

afterEach(() => vi.unstubAllGlobals());

describe("person page", () => {
  it("shows an approver the actions the person's status allows", async () => {
    user.current = me("approver");
    stubApi({ "GET /people/7": { body: personDetail() } });
    renderPage(<PersonPage id={7} />);
    expect(await screen.findByRole("heading", { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/people/7/edit");
    expect(screen.getByRole("button", { name: "Start onboarding" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start offboarding" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive" })).toBeVisible();
    // An access update needs an onboarding or active person.
    expect(screen.queryByRole("button", { name: "Apply access" })).not.toBeInTheDocument();
    // What the profile grants, next to the account the app knows (none yet).
    const access = screen.getByRole("region", { name: "Access" });
    expect(within(access).getByText("Keycloak")).toBeVisible();
    expect(within(access).getByText("none known")).toBeVisible();
  });

  it("hides every action from a viewer", async () => {
    user.current = me("viewer");
    stubApi({ "GET /people/7": { body: personDetail() } });
    renderPage(<PersonPage id={7} />);
    expect(await screen.findByRole("heading", { name: /Ada Lovelace/ })).toBeInTheDocument();
    for (const name of ["Edit", "Start onboarding", "Start offboarding", "Archive"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
  });

  it("asks before offboarding, then leads to the new workflow", async () => {
    user.current = me("approver");
    const fetch = stubApi({
      "GET /people/7": {
        body: personDetail({
          status: "active",
          can: { onboard: false, update: true, offboard: true, archive: false },
        }),
      },
      "POST /people/7/start/offboarding": { body: { id: 31, message: "Started offboarding." } },
    });
    const click = userEvent.setup();
    const { router } = renderPage(<PersonPage id={7} />);
    await click.click(await screen.findByRole("button", { name: "Start offboarding" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Start offboarding of Ada Lovelace?");
    expect(requests(fetch, "POST /people/7/start/offboarding")).toHaveLength(0);
    await click.click(within(dialog).getByRole("button", { name: "Start offboarding" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows/31"));
    expect(await screen.findByText("Started offboarding.")).toBeVisible();
  });

  it("shows the reason when a workflow cannot start (409)", async () => {
    user.current = me("approver");
    stubApi({
      "GET /people/7": { body: personDetail() },
      "POST /people/7/start/onboarding": {
        status: 409,
        body: { error: { code: "lifecycle", message: "Choose an access profile before onboarding." } },
      },
    });
    const click = userEvent.setup();
    const { router } = renderPage(<PersonPage id={7} />);
    await click.click(await screen.findByRole("button", { name: "Start onboarding" }));
    expect(await screen.findByText("Choose an access profile before onboarding.")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });

  it("warns when the end date has passed before onboarding", async () => {
    user.current = me("approver");
    stubApi({ "GET /people/7": { body: personDetail({ endDate: "2026-11-01", onboardingPaused: true }) } });
    renderPage(<PersonPage id={7} />);
    expect(
      await screen.findByText(
        /The end date has passed. Clear or change it before onboarding, or the schedule offboards Ada/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/The last onboarding was cancelled/)).toBeVisible();
  });

  it("shows the end date of a person added here", async () => {
    user.current = me("viewer");
    stubApi({ "GET /people/7": { body: personDetail({ endDate: "2027-03-31" }) } });
    renderPage(<PersonPage id={7} />);
    expect((await screen.findByText("End date")).nextSibling).toHaveTextContent("Mar 31, 2027");
    expect(screen.queryByText("Last day at work")).not.toBeInTheDocument();
    expect(screen.queryByText(/Offboarding is due/)).not.toBeInTheDocument();
  });

  it("shows Personio's three end dates and which one offboarding follows", async () => {
    user.current = me("viewer");
    const imported = {
      status: "active" as const,
      source: { connection: "Personio", id: "37" },
      endDate: "2026-12-04",
      contractEndDate: "2028-06-14",
      terminationDate: "2027-01-14",
      lastDayAtWork: "2026-12-04",
    };
    stubApi({ "GET /people/7": { body: personDetail(imported) } });
    renderPage(<PersonPage id={7} />);
    const value = (label: string) => screen.getByText(label).nextSibling;
    expect((await screen.findByText("Contract ends")).nextSibling).toHaveTextContent("Jun 14, 2028");
    expect(value("Termination date")).toHaveTextContent("Jan 14, 2027");
    expect(value("Last day at work")).toHaveTextContent("Dec 4, 2026");
    expect(screen.queryByText("End date")).not.toBeInTheDocument();
    expect(screen.getByText("Offboarding is due after Dec 4, 2026, the last day at work.")).toBeVisible();
  });

  it("keeps the end date of a leaver whose Personio dates were never imported", async () => {
    user.current = me("viewer");
    const left = {
      status: "offboarded" as const,
      source: { connection: "Personio", id: "12" },
      endDate: "2026-03-31",
    };
    stubApi({ "GET /people/7": { body: personDetail(left) } });
    renderPage(<PersonPage id={7} />);
    expect(await screen.findByText("End date: Mar 31, 2026.")).toBeVisible();
    expect(screen.queryByText(/Offboarding is due/)).not.toBeInTheDocument();
  });

  it("says when HR has not set the last day at work", async () => {
    user.current = me("viewer");
    const imported = {
      status: "active" as const,
      source: { connection: "Personio", id: "37" },
      endDate: "2027-01-14",
      terminationDate: "2027-01-14",
    };
    stubApi({ "GET /people/7": { body: personDetail(imported) } });
    renderPage(<PersonPage id={7} />);
    expect((await screen.findByText("Last day at work")).nextSibling).toHaveTextContent("—");
    expect(screen.getByText("Offboarding is due after Jan 14, 2027, the termination date.")).toBeVisible();
  });
});
