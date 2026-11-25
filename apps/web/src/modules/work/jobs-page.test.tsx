import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobRow, Me } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { JobsPage } from "./lists";

const user = vi.hoisted(() => ({ current: null as Me | null }));
vi.mock("@/hooks/use-me", () => ({ useMe: () => user.current }));

afterEach(() => vi.unstubAllGlobals());

function jobRow(overrides: Partial<JobRow>): JobRow {
  return {
    id: 1,
    action: "ensure_account",
    status: "failed",
    attempts: 3,
    lastError: "",
    result: {},
    createdAt: "2026-11-20T09:00:00.000Z",
    nextAttemptAt: "2026-11-20T09:00:00.000Z",
    person: { id: 7, name: "Ada Lovelace" },
    connection: { id: 5, name: "Keycloak" },
    workflow: { id: 31, kind: "onboarding" },
    ...overrides,
  };
}

const page = (items: JobRow[]) => ({ body: { items, page: 1, pages: 1, total: items.length } });

describe("jobs page", () => {
  it("shows what a rehearsed job would do, the attempts and each row's actions", async () => {
    user.current = me("admin");
    stubApi({
      "GET /jobs": page([
        jobRow({ id: 1, status: "failed", lastError: "x".repeat(200) }),
        jobRow({ id: 2, status: "held", action: "disable_account", attempts: 0 }),
        jobRow({
          id: 3,
          status: "rehearsed",
          lastError: "an old error",
          result: { would: "create the account", groups_to_add: "staff", groups_to_remove: "none" },
        }),
      ]),
      "GET /connection-names": { body: [] },
    });
    renderPage(<JobsPage search={{}} onSearch={() => undefined} />);
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(within(rows[0]!).getByText(`${"x".repeat(139)}…`)).toBeVisible();
    expect(within(rows[0]!).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(within(rows[0]!).getByText("3")).toBeVisible();
    expect(within(rows[1]!).getByRole("button", { name: "Approve" })).toBeVisible();
    expect(within(rows[1]!).getByRole("button", { name: "Reject" })).toBeVisible();
    expect(within(rows[2]!).getByText("Would create the account · add to staff")).toBeVisible();
    expect(within(rows[2]!).queryByText("an old error")).not.toBeInTheDocument();
  });

  it("shows a viewer no actions", async () => {
    user.current = me("viewer");
    stubApi({ "GET /jobs": page([jobRow({ status: "failed" })]), "GET /connection-names": { body: [] } });
    renderPage(<JobsPage search={{}} onSearch={() => undefined} />);
    expect(await screen.findByText("Ada Lovelace")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("asks for jobs that need attention by default, and filters by connection", async () => {
    user.current = me("viewer");
    const fetch = stubApi({
      "GET /jobs": page([]),
      "GET /connection-names": {
        body: [{ id: 5, name: "Keycloak" }],
      },
    });
    const onSearch = vi.fn();
    const click = userEvent.setup();
    renderPage(<JobsPage search={{}} onSearch={onSearch} />);
    expect(await screen.findByText("No jobs.")).toBeVisible();
    expect(requests(fetch, "GET /jobs")[0]!.url).toContain("status=attention");
    await waitFor(() => expect(screen.getByRole("option", { name: "Keycloak" })).toBeInTheDocument());
    await click.selectOptions(screen.getByLabelText("Connection"), "Keycloak");
    expect(onSearch).toHaveBeenCalledWith({ connection: 5 });
  });
});
