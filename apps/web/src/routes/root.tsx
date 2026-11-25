import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { useThemePreference } from "@/components/ui/theme";
import { common } from "@/i18n/common";
import { useT } from "@/i18n";

export type RouterContext = { queryClient: QueryClient };

function NotFound() {
  const t = useT(common);
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        title={t("notFound")}
        description={t("notFoundText")}
        action={
          <Button asChild variant="outline">
            <Link to="/">{t("back")}</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Every page, signed in or not: the person's appearance (saved in this browser), the toasts. */
function Root() {
  useThemePreference();
  return (
    <>
      <Outlet />
      {/* Above the sticky save bars of forms, so a toast never covers Save. */}
      <Toaster richColors closeButton offset={{ bottom: 80 }} mobileOffset={{ bottom: 80 }} />
    </>
  );
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});
