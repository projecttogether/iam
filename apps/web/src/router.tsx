import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { LoadingState } from "@/components/ui/states";
import { queryClient } from "@/lib/query";
import { rootRoute } from "@/routes/root";
import { appRoute } from "@/routes/app";
import { deniedRoute, devSignInRoute, signInRoute } from "@/routes/sign-in";
import { appRoutes } from "@/modules";

const routeTree = rootRoute.addChildren([
  signInRoute,
  devSignInRoute,
  deniedRoute,
  appRoute.addChildren(appRoutes),
]);

/** The app's router; tests pass a memory history and their own query client. */
export function createAppRouter(options: { history?: RouterHistory; queryClient?: QueryClient } = {}) {
  return createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient ?? queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: () => <LoadingState />,
    scrollRestoration: true,
    // Paths of the Django version end with a slash: /people/7/ opens /people/7.
    trailingSlash: "never",
  });
}

export const router = createAppRouter();
