import { createRoute, notFound, redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { Me } from "@iam/shared/api/iam";
import { ApiError } from "@/lib/api";
import { meQuery } from "@/hooks/use-me";
import { AppLayout } from "@/components/layout/app-layout";
import { rootRoute } from "./root";

/**
 * The signed-in application. Every module's routes are children of this
 * route (`getParentRoute: () => appRoute`); it loads the signed-in app user
 * first and sends everyone else to the sign-in page.
 */
export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireSignIn,
  component: AppLayout,
});

export async function requireSignIn({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { href: string };
}) {
  try {
    await context.queryClient.ensureQueryData(meQuery);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: "/login", search: { next: location.href } });
    }
    throw error;
  }
}

/** `beforeLoad` of pages for a role: others see "not found" (the server enforces the role too). */
export function requireRole(role: "approver" | "admin") {
  return async ({ context }: { context: { queryClient: QueryClient } }) => {
    const me: Me = await context.queryClient.ensureQueryData(meQuery);
    if (role === "admin" ? !me.isAdmin : !me.isApprover) throw notFound();
  };
}
