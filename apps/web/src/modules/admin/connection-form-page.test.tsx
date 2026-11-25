import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterInfo, ConnectionForm } from "@iam/shared/api/iam";
import { renderPage, requests, stubApi } from "@/test-utils";
import { ConnectionFormPage } from "./connection-form-page";

afterEach(() => vi.unstubAllGlobals());

const adapter: AdapterInfo = {
  slug: "example",
  name: "Example",
  kind: "provisioning",
  description: "Creates accounts in an example app.",
  fields: [
    {
      name: "url",
      label: "URL",
      kind: "url",
      required: true,
      help: "",
      default: null,
      choices: [],
      placeholder: "https://example.invalid",
    },
    {
      name: "token",
      label: "API token",
      kind: "secret",
      required: true,
      help: "",
      default: null,
      choices: [],
      placeholder: "",
    },
    {
      name: "webhook_secret",
      label: "Webhook secret",
      kind: "secret",
      required: false,
      help: "Optional.",
      default: null,
      choices: [],
      placeholder: "",
    },
    {
      name: "interval",
      label: "Sync interval",
      kind: "int",
      required: false,
      help: "",
      default: 60,
      choices: [],
      placeholder: "",
    },
    {
      name: "verify",
      label: "Verify TLS",
      kind: "bool",
      required: false,
      help: "",
      default: true,
      choices: [],
      placeholder: "",
    },
  ],
  hasMode: true,
  supportsWrite: true,
  supportsGroups: true,
  groupLabel: "Groups",
  manualGroups: false,
};

const saved: ConnectionForm = {
  adapter,
  name: "Example",
  enabled: true,
  mode: "automatic",
  settings: { url: "https://example.invalid", interval: 60, verify: true },
  savedSecrets: ["token"],
};

/** The field group of a labelled control or of a label. */
function fieldOf(label: string): HTMLElement {
  return screen.getByText(label, { selector: "label" }).closest<HTMLElement>("[data-slot=field]")!;
}

describe("connection form", () => {
  it("never pre-fills a saved secret and sends only the secrets entered", async () => {
    const fetch = stubApi({
      "GET /connections/7/form": { body: saved },
      "PUT /connections/7": { body: { id: 7, message: "Saved Example." } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<ConnectionFormPage id={7} />);
    expect(await screen.findByRole("heading", { name: "Edit Example" })).toBeVisible();
    // The saved token shows as saved, without an input or a value.
    const token = fieldOf("API token *");
    expect(token).toHaveTextContent("Stored");
    expect(token).toHaveTextContent("Saved. Leave empty to keep it.");
    expect(token.querySelector("input")).toBeNull();
    for (const input of document.querySelectorAll("input")) expect(input.value).not.toMatch(/secret|token/i);
    // Replacing it starts empty.
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("API token *")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Keep stored value" }));
    await user.type(screen.getByLabelText("Webhook secret"), "whsec-new");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/connections/7"));
    expect(await screen.findByText("Saved Example.")).toBeVisible();
    expect(requests(fetch, "PUT /connections/7")[0]!.body).toEqual({
      name: "Example",
      enabled: true,
      mode: "automatic",
      settings: { url: "https://example.invalid", interval: "60", verify: true },
      secrets: { webhook_secret: "whsec-new" },
    });
  });

  it("keeps settings the connection never saved empty, and sends them back unchanged", async () => {
    // The server sends "" (false for a bool) for them, not the adapter's default.
    const fetch = stubApi({
      "GET /connections/7/form": {
        body: { ...saved, settings: { url: "https://example.invalid", interval: "", verify: false } },
      },
      "PUT /connections/7": { body: { id: 7, message: "Saved Example." } },
    });
    const user = userEvent.setup();
    renderPage(<ConnectionFormPage id={7} />);
    expect(await screen.findByLabelText("Sync interval")).toHaveValue(null);
    expect(screen.getByRole("checkbox", { name: "Verify TLS" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "PUT /connections/7")).toHaveLength(1));
    expect(requests(fetch, "PUT /connections/7")[0]!.body).toMatchObject({
      settings: { url: "https://example.invalid", interval: "", verify: false },
      secrets: {},
    });
  });

  it("shows a server error of a secret under that field, with an input to enter it again", async () => {
    stubApi({
      "GET /connections/7/form": { body: saved },
      "PUT /connections/7": {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Check the highlighted fields",
            fields: { "secrets.token": "Enter it again: URL changed where it is sent." },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderPage(<ConnectionFormPage id={7} />);
    const url = await screen.findByLabelText("URL *");
    await user.clear(url);
    await user.type(url, "https://other.example.invalid");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const message = await screen.findByText("Enter it again: URL changed where it is sent.");
    expect(fieldOf("API token *")).toContainElement(message);
    expect(screen.getByLabelText("API token *")).toHaveValue("");
    expect(screen.getByLabelText("API token *")).toHaveAttribute("aria-invalid", "true");
  });

  it("adds a connection with the adapter's defaults", async () => {
    const fetch = stubApi({
      "GET /adapters/example": { body: adapter },
      "POST /connections": {
        status: 201,
        body: { id: 9, message: "Added Example. Test it before turning it on." },
      },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<ConnectionFormPage adapter="example" />);
    expect(await screen.findByRole("heading", { name: "Add Example" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
    await user.type(screen.getByLabelText("URL *"), "https://example.invalid");
    await user.type(screen.getByLabelText("API token *"), "tok-123");
    await user.selectOptions(screen.getByLabelText("Mode"), "read_only");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/connections/9"));
    expect(requests(fetch, "POST /connections")[0]!.body).toEqual({
      adapter: "example",
      name: "Example",
      enabled: false,
      mode: "read_only",
      settings: { url: "https://example.invalid", interval: "60", verify: true },
      secrets: { token: "tok-123" },
    });
  });
});
