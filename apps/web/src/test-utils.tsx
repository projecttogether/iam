import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Renders with a fresh query client. */
export function renderWithProviders(ui: ReactNode) {
  const client = testQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * Renders a page at "/" inside a router, with tooltips and toasts. Every
 * other address shows "At <path>", so tests can follow links and navigations.
 */
export function renderPage(ui: ReactNode) {
  const client = testQueryClient();
  const rootRoute = createRootRoute({
    component: () => (
      <TooltipProvider>
        <Outlet />
        <Toaster />
      </TooltipProvider>
    ),
  });
  const page = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{ui}</> });
  const elsewhere = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: function Elsewhere() {
      const location = useRouterState({ select: (state) => state.location });
      return <p>At {location.pathname + location.searchStr}</p>;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, elsewhere]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router, client };
}

type Reply = { status?: number; body?: unknown };

function respond(reply: Reply) {
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const NO_REPLY: Reply = { status: 500, body: { error: { code: "internal_error", message: "No reply" } } };

/** Stubs fetch: each call gets the next reply; returns the mock to inspect requests. */
export function stubFetch(...replies: Reply[]) {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => respond(replies.shift() ?? NO_REPLY));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Stubs fetch by route: keys are "METHOD /path" below /api/v1 (without the
 * query), values a reply or a list of replies used in turn (the last one
 * repeats). Returns the mock; `calls(mock, "POST /sources")` lists the bodies.
 */
export function stubApi(routes: Record<string, Reply | Reply[]>) {
  const used: Record<string, number> = {};
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]!.replace(/^\/api\/v1/, "")}`;
    const entry = routes[key];
    if (entry === undefined) return respond(NO_REPLY);
    const list = Array.isArray(entry) ? entry : [entry];
    const index = Math.min(used[key] ?? 0, list.length - 1);
    used[key] = (used[key] ?? 0) + 1;
    return respond(list[index]!);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The requests of a stub to "METHOD /path": their URL (with query) and JSON body. */
export function requests(mock: ReturnType<typeof stubApi>, route: string) {
  const [method, path] = route.split(" ");
  return mock.mock.calls
    .filter(([url, init]) => (init?.method ?? "GET") === method && url.split("?")[0] === `/api/v1${path}`)
    .map(([url, init]) => ({
      url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    }));
}
