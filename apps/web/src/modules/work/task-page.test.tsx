import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, TaskDetail } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { me } from "@/modules/people/fixtures";
import { TaskPage } from "./task-page";

const user = vi.hoisted(() => ({ current: null as Me | null }));
vi.mock("@/hooks/use-me", () => ({ useMe: () => user.current }));

afterEach(() => vi.unstubAllGlobals());

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 12,
    title: "Create an account at Payroll for Ada Lovelace",
    kind: "change",
    status: "open",
    createdAt: "2026-11-20T09:00:00.000Z",
    person: { id: 7, name: "Ada Lovelace" },
    connection: { id: 4, name: "Payroll" },
    jobId: 30,
    instructions: "1. Open Payroll.\n2. Add Ada.",
    completedAt: null,
    completedBy: null,
    note: "",
    ...overrides,
  };
}

describe("task page", () => {
  it("closes an open task as done with the note", async () => {
    user.current = me("approver");
    const fetch = stubApi({
      "GET /tasks/12": [
        { body: task() },
        {
          body: task({
            status: "done",
            completedAt: "2026-11-20T10:00:00.000Z",
            completedBy: "approver",
            note: "Added her.",
          }),
        },
      ],
      "POST /tasks/12/complete": { body: { id: 12, message: "Task completed." } },
    });
    const click = userEvent.setup();
    renderPage(<TaskPage id={12} />);
    expect(await screen.findByText(/2\. Add Ada\./)).toBeVisible();
    await click.type(screen.getByLabelText("Note (optional)"), "Added her.");
    await click.click(screen.getByRole("button", { name: "Mark as done" }));
    await waitFor(() => expect(requests(fetch, "POST /tasks/12/complete")).toHaveLength(1));
    expect(requests(fetch, "POST /tasks/12/complete")[0]!.body).toEqual({ note: "Added her." });
    expect(await screen.findByText("Task completed.")).toBeVisible();
    // The task is closed now: the form gives way to who closed it.
    expect(await screen.findByText(/by approver/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Mark as done" })).not.toBeInTheDocument();
  });

  it("shows a viewer the instructions without the close form", async () => {
    user.current = me("viewer");
    stubApi({ "GET /tasks/12": { body: task() } });
    renderPage(<TaskPage id={12} />);
    expect(await screen.findByRole("heading", { name: "What to do" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Mark as done" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel task" })).not.toBeInTheDocument();
  });

  it("shows why a close failed (409)", async () => {
    user.current = me("approver");
    stubApi({
      "GET /tasks/12": { body: task() },
      "POST /tasks/12/cancel": {
        status: 409,
        body: { error: { code: "action", message: "This task is already closed." } },
      },
    });
    const click = userEvent.setup();
    renderPage(<TaskPage id={12} />);
    await click.click(await screen.findByRole("button", { name: "Cancel task" }));
    expect(await screen.findByText("This task is already closed.")).toBeVisible();
  });
});
