import { describe, expect, it } from "vitest";
import { breadcrumbsFor, navigationFor } from "./navigation";

const items = (isAdmin: boolean) =>
  navigationFor({ isAdmin }).flatMap((group) => group.items.map((item) => ({ ...item, href: item.to })));

const crumbs = (pathname: string, record?: string) =>
  breadcrumbsFor(pathname, { items: items(true), record, preferences: "My settings" });

describe("navigation", () => {
  it("shows the admin section to admins only", () => {
    expect(navigationFor({ isAdmin: false }).map((group) => group.label)).toEqual([
      undefined,
      "Access policy",
    ]);
    expect(navigationFor({ isAdmin: true }).map((group) => group.label)).toEqual([
      undefined,
      "Access policy",
      "Admin",
    ]);
  });

  it("gives G keys to the main pages only, with a letter one can guess", () => {
    const keys = Object.fromEntries(
      items(true)
        .filter((item) => item.shortcut)
        .map((item) => [item.shortcut, item.label]),
    );
    expect(keys).toEqual({
      o: "Dashboard",
      p: "People",
      r: "Requests",
      t: "Tasks",
      w: "Workflows",
      j: "Jobs",
      a: "Access profiles",
    });
    const admin = navigationFor({ isAdmin: true }).find((group) => group.label === "Admin")!;
    expect(admin.items.filter((item) => item.shortcut)).toEqual([]);
  });
});

describe("breadcrumbs", () => {
  it("names a sidebar page by its item", () => {
    expect(crumbs("/")).toEqual([{ label: "Dashboard" }]);
    expect(crumbs("/people")).toEqual([{ label: "People" }]);
    expect(crumbs("/people/")).toEqual([{ label: "People" }]);
    expect(crumbs("/admin/settings")).toEqual([{ label: "Settings" }]);
  });

  it("names the person's own settings apart from the admin settings", () => {
    expect(crumbs("/preferences")).toEqual([{ label: "My settings" }]);
  });

  it("shows a record by its name once its page has it", () => {
    expect(crumbs("/people/7")).toEqual([{ label: "People", href: "/people" }, { label: "Details" }]);
    expect(crumbs("/people/7", "Ada Lovelace")).toEqual([
      { label: "People", href: "/people" },
      { label: "Ada Lovelace" },
    ]);
    expect(crumbs("/requests/3/approve", "Grace Hopper")).toEqual([
      { label: "Requests", href: "/requests" },
      { label: "Grace Hopper", href: "/requests/3" },
      { label: "Approve" },
    ]);
    expect(crumbs("/people/7/edit", "Ada Lovelace")).toEqual([
      { label: "People", href: "/people" },
      { label: "Ada Lovelace", href: "/people/7" },
      { label: "Edit" },
    ]);
  });

  it("shows new records and the choice of app before the connection form", () => {
    expect(crumbs("/people/new")).toEqual([{ label: "People", href: "/people" }, { label: "New" }]);
    expect(crumbs("/admin/connections/new/keycloak", "Keycloak")).toEqual([
      { label: "Connections", href: "/admin/connections" },
      { label: "New", href: "/admin/connections/new" },
      { label: "Keycloak" },
    ]);
  });

  it("shows none outside the sidebar", () => {
    expect(crumbs("/elsewhere")).toEqual([]);
  });
});
