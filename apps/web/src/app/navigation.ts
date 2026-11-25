import type { Me } from "@iam/shared/api/iam";

/**
 * `shortcut`: "G then this letter" opens the page. Only for main pages people
 * open often, with a letter they can guess, each letter once; none for admin
 * pages; "o" is the start page.
 */
export type NavItem = {
  label: string;
  to: string;
  shortcut?: string;
  badge?: "tasks" | "jobs" | "requests";
};
export type NavGroup = { label?: string; items: NavItem[] };

/**
 * The sidebar, as text. Viewers and approvers see the work and the access
 * policy; admins also the admin section. The main action ("Add person")
 * sits in the header of the people page.
 */
export function navigationFor(me: Pick<Me, "isAdmin">): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [
        { label: "Dashboard", to: "/", shortcut: "o" },
        { label: "People", to: "/people", shortcut: "p" },
        { label: "Requests", to: "/requests", shortcut: "r", badge: "requests" },
        { label: "Tasks", to: "/tasks", shortcut: "t", badge: "tasks" },
        { label: "Workflows", to: "/workflows", shortcut: "w" },
        { label: "Jobs", to: "/jobs", shortcut: "j", badge: "jobs" },
      ],
    },
    {
      label: "Access policy",
      items: [
        { label: "Access profiles", to: "/profiles", shortcut: "a" },
        { label: "Teams", to: "/teams" },
        { label: "Audit log", to: "/audit" },
      ],
    },
  ];
  if (me.isAdmin) {
    groups.push({
      label: "Admin",
      items: [
        { label: "Connections", to: "/admin/connections" },
        { label: "Users and roles", to: "/admin/users" },
        { label: "API keys", to: "/admin/api-keys" },
        { label: "Settings", to: "/admin/settings" },
      ],
    });
  }
  return groups;
}

/** The person's own settings (appearance, keyboard shortcuts), outside the sidebar. */
export const PREFERENCES_PATH = "/preferences";

export type Crumb = { label: string; href?: string };

/** Labels of the pages below a sidebar item. */
const SUB_PAGES: Record<string, string> = { new: "New", edit: "Edit", approve: "Approve" };

/**
 * Where a page sits: the sidebar item it belongs to, then the record by its
 * name (until its page has loaded it, "Details"), then the new or edit form.
 */
export function breadcrumbsFor(
  pathname: string,
  options: { items: { label: string; href: string }[]; record?: string; preferences: string },
): Crumb[] {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === PREFERENCES_PATH) return [{ label: options.preferences }];
  const item = options.items
    .filter((candidate) =>
      candidate.href === "/"
        ? path === "/"
        : path === candidate.href || path.startsWith(`${candidate.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (!item) return [];
  if (path === item.href) return [{ label: item.label }];
  const parent = { label: item.label, href: item.href };
  const [first, second, third] = path.slice(item.href.length + 1).split("/");
  if (first === "new") {
    // /admin/connections/new/<adapter>: the choice of app, then the form.
    return second
      ? [parent, { label: "New", href: `${item.href}/new` }, { label: options.record ?? "Form" }]
      : [parent, { label: "New" }];
  }
  const record = { label: options.record ?? "Details", href: `${item.href}/${first}` };
  if (second && SUB_PAGES[second] && !third) return [parent, record, { label: SUB_PAGES[second]! }];
  return [parent, { label: record.label }];
}
