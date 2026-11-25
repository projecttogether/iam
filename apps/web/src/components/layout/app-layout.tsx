import { useEffect } from "react";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { AppFrame, type FrameLink, type NavGroup, type SearchResult } from "@/components/ui/app-frame";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useThemePreference } from "@/components/ui/theme";
import { ROLE_LABELS } from "@iam/shared/labels";
import type { Paged, PersonRow } from "@iam/shared/api/iam";
import { useMe } from "@/hooks/use-me";
import { DEFAULT_APP_NAME as APP_NAME } from "@/lib/auth-config";
import { api } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { breadcrumbsFor, navigationFor, PREFERENCES_PATH } from "@/app/navigation";
import { useRecordName } from "@/app/record-name";
import { AppIcon, SidebarOrganization } from "@/components/brand";

/**
 * TanStack Router's link for the frame: every other prop goes on to the <a>.
 * Exact, so that the router marks only the page itself as current, not the
 * breadcrumb of its parent; the frame marks the sidebar item.
 */
const AppLink: FrameLink = ({ href, ...props }) => (
  <Link to={href} activeOptions={{ exact: true }} {...props} />
);

function Count({ value, alert }: { value: number; alert?: boolean }) {
  if (!value) return null;
  return (
    <span
      className={
        alert
          ? "bg-destructive text-destructive-foreground rounded-full px-1.5 text-xs tabular-nums"
          : "bg-muted text-muted-foreground rounded-full px-1.5 text-xs tabular-nums"
      }
    >
      {value}
    </span>
  );
}

/** People by name, email or username, for the frame's search. */
async function findPeople(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const page = await api.get<Paged<PersonRow>>("/people", { q: query }, signal);
  return page.items.slice(0, 8).map((person) => ({
    href: `/people/${person.id}`,
    title: person.name,
    kind: "Person",
  }));
}

/** The signed-in application frame: the AppFrame with the navigation of IAM. */
export function AppLayout() {
  const me = useMe();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const record = useRecordName(pathname);
  const [theme, setTheme] = useThemePreference();
  const appName = me.organizationName || APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  const nav: NavGroup[] = navigationFor(me).map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      label: item.label,
      href: item.to,
      shortcut: item.shortcut,
      badge:
        item.badge === "tasks" ? (
          <Count value={me.counts.openTasks} />
        ) : item.badge === "jobs" ? (
          <Count value={me.counts.failedJobs + me.counts.heldJobs} alert />
        ) : item.badge === "requests" ? (
          <Count value={me.counts.openRequests} />
        ) : undefined,
    })),
  }));
  const breadcrumbs = breadcrumbsFor(pathname, {
    items: nav.flatMap((group) => group.items),
    record,
    preferences: "My settings",
  });

  const signOut = async () => {
    const { redirect } = await api
      .post<{ redirect: string }>("/auth/logout")
      .catch(() => ({ redirect: "/login" }));
    queryClient.clear();
    window.location.assign(redirect);
  };

  return (
    <AppFrame
      app={{
        name: appName,
        icon: <AppIcon />,
        // The software under the organization's name.
        description: appName === APP_NAME ? undefined : APP_NAME,
      }}
      sidebarFooter={<SidebarOrganization />}
      nav={nav}
      pathname={pathname}
      link={AppLink}
      navigate={(href) => {
        // Keep a query ("Show all results" opens /people?q=…): TanStack takes it apart.
        const url = new URL(href, window.location.origin);
        void router.navigate({ to: url.pathname, search: Object.fromEntries(url.searchParams) as never });
      }}
      user={{ name: me.name, email: me.email, detail: ROLE_LABELS[me.role] }}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref={PREFERENCES_PATH}
      onSignOut={() => void signOut()}
      breadcrumbs={breadcrumbs}
      search={{ find: findPeople, allResultsHref: (query) => `/people?q=${encodeURIComponent(query)}` }}
      // The sign-in provider's account page is on the person's settings page, not here.
    >
      {me.readOnly ? (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4 md:px-6">
          <Alert>
            <AlertDescription>
              <span>
                <strong>Read-only mode.</strong> The app reads connected apps but changes nothing in them and
                sends no email. Workflows run as rehearsals: each job only checks what it would change.
              </span>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <Outlet />
    </AppFrame>
  );
}
