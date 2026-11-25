import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDetail, Me } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { JobPage, resultText } from "./job-page";

const user = vi.hoisted(() => ({ current: null as Me | null }));
vi.mock("@/hooks/use-me", () => ({ useMe: () => user.current }));

afterEach(() => vi.unstubAllGlobals());

function job(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 30,
    action: "disable_account",
    status: "held",
    attempts: 0,
    lastError: "",
    createdAt: "2026-11-20T09:00:00.000Z",
    nextAttemptAt: "2026-11-20T09:00:00.000Z",
    person: { id: 7, name: "Ada Lovelace" },
    connection: { id: 5, name: "Keycloak" },
    workflow: { id: 31, kind: "offboarding" },
    groups: [],
    finishedAt: null,
    result: {},
    tasks: [],
    events: [],
    ...overrides,
  };
}

describe("job page", () => {
  it("lets an admin approve a held removal", async () => {
    user.current = me("admin");
    const fetch = stubApi({
      "GET /jobs/30": { body: job() },
      "POST /jobs/30/approve": { body: { id: 30, message: "Approved. The job runs now." } },
    });
    const click = userEvent.setup();
    renderPage(<JobPage id={30} />);
    expect(await screen.findByText(/over the daily limit/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject" })).toBeVisible();
    await click.click(screen.getByRole("button", { name: "Approve removal" }));
    await waitFor(() => expect(requests(fetch, "POST /jobs/30/approve")).toHaveLength(1));
    expect(await screen.findByText("Approved. The job runs now.")).toBeVisible();
  });

  it("leaves held removals to admins and retries failed jobs for approvers", async () => {
    user.current = me("approver");
    stubApi({ "GET /jobs/30": { body: job() } });
    const { unmount } = renderPage(<JobPage id={30} />);
    expect(await screen.findByText(/over the daily limit/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve removal" })).not.toBeInTheDocument();
    unmount();
    stubApi({ "GET /jobs/30": { body: job({ status: "failed", lastError: "Timeout" }) } });
    renderPage(<JobPage id={30} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("shows the result as a list of values", async () => {
    user.current = me("viewer");
    stubApi({
      "GET /jobs/30": {
        body: job({
          status: "succeeded",
          result: { would: "create", password_generated: false, created: true, groups_added: "" },
        }),
      },
    });
    renderPage(<JobPage id={30} />);
    expect(await screen.findByText("password_generated")).toBeVisible();
    expect(screen.getByText("password_generated").nextSibling).toHaveTextContent("no");
    expect(screen.getByText("created").nextSibling).toHaveTextContent("yes");
    expect(screen.getByText("groups_added").nextSibling).toHaveTextContent("—");
  });
});

describe("resultText", () => {
  it("writes values as Django's template did", () => {
    expect(resultText(true)).toBe("yes");
    expect(resultText(false)).toBe("no");
    expect(resultText(null)).toBe("—");
    expect(resultText(["a", "b"])).toBe("a, b");
    expect(resultText(0)).toBe("0");
  });
});
