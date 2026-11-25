import { useState } from "react";
import { createRoute, notFound, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { LogIn } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { SignInPage as SignInLayout } from "@/components/ui/sign-in-page";
import { Spinner } from "@/components/ui/spinner";
import { AppIcon, MadeBy } from "@/components/brand";
import { authConfigQuery, DEFAULT_APP_NAME, useAuthConfig } from "@/lib/auth-config";
import { api, apiUrl, errorMessage } from "@/lib/api";
import { rootRoute } from "./root";

const TAGLINE = "People, access profiles, onboarding and offboarding across your connected apps.";

const searchSchema = z.object({
  next: z.string().optional().catch(undefined),
  error: z.enum(["denied", "unavailable"]).optional().catch(undefined),
});

/** Only paths of this app, never another origin. */
export function safeNext(target: string | undefined): string {
  return target &&
    target.startsWith("/") &&
    !target.startsWith("//") &&
    !target.startsWith("/\\") &&
    !target.startsWith("/login")
    ? target
    : "/";
}

/** Sends the browser away from a sign-in page when a session exists already. */
async function leaveWhenSignedIn(next: string | undefined) {
  // The public settings say whether a session came along: no 401 for people who are signed out.
  const response = await fetch(apiUrl("/auth-config"), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).catch(() => null);
  const config = response?.ok ? ((await response.json()) as { signedIn?: boolean }) : null;
  if (config?.signedIn) throw redirect({ to: safeNext(next) });
}

function SignInPage() {
  const config = useAuthConfig();
  const search = signInRoute.useSearch();
  const [pending, setPending] = useState(false);
  const target = `/oidc/authenticate/?next=${encodeURIComponent(safeNext(search.next))}`;
  return (
    <SignInLayout
      app={{ name: DEFAULT_APP_NAME, icon: <AppIcon className="size-9" /> }}
      tagline={TAGLINE}
      footer={<MadeBy appName={DEFAULT_APP_NAME} />}
    >
      {search.error === "denied" ? (
        <Alert variant="destructive">
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>
            You signed in, but this app has no active user for you. Ask an admin to add your email address in
            Admin › Users and roles, then sign in again.
          </AlertDescription>
        </Alert>
      ) : null}
      {search.error === "unavailable" ? (
        <Alert variant="destructive">
          <AlertTitle>Sign-in unavailable</AlertTitle>
          <AlertDescription>
            The sign-in provider cannot be reached right now. Try again in a minute. If this persists, check
            the provider and OIDC_ISSUER.
          </AlertDescription>
        </Alert>
      ) : null}
      {config && !config.oidcEnabled ? (
        <Alert>
          <AlertDescription>
            Sign-in is not set up. Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET (or KEYCLOAK_URL and
            KEYCLOAK_REALM); see docs/authentication.md.
          </AlertDescription>
        </Alert>
      ) : (
        <Button asChild disabled={pending}>
          {/* A full page load: the server redirects to the provider. */}
          <a href={target} onClick={() => setPending(true)}>
            {pending ? <Spinner /> : <LogIn />}
            {config ? `Sign in with ${config.providerName}` : "Sign in"}
          </a>
        </Button>
      )}
      {config?.devLogin ? (
        <p className="text-muted-foreground text-sm">
          <a className="underline underline-offset-4" href="/login/dev">
            Development sign-in
          </a>
        </p>
      ) : null}
    </SignInLayout>
  );
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: searchSchema,
  // With an error to show, the page stays, signed in or not (a refused switch of accounts).
  beforeLoad: ({ search }) => (search.error ? undefined : leaveWhenSignedIn(search.next)),
  component: SignInPage,
});

function DevSignInPage() {
  const users = useQuery({
    queryKey: ["dev-users"],
    queryFn: () => api.get<{ email: string; role: string }[]>("/auth/dev-users"),
  });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const chosen = email || users.data?.[0]?.email || "";
  const signIn = async () => {
    setError(null);
    try {
      await api.post("/auth/dev-login", { email: chosen });
      window.location.assign("/");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  return (
    <SignInLayout
      app={{ name: DEFAULT_APP_NAME, icon: <AppIcon className="size-9" /> }}
      tagline={TAGLINE}
      footer={<MadeBy appName={DEFAULT_APP_NAME} />}
    >
      <Alert>
        <AlertDescription>Development only. Never enable DEV_LOGIN on a server.</AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="dev-email">App user</Label>
        <NativeSelect id="dev-email" value={chosen} onChange={(event) => setEmail(event.target.value)}>
          {(users.data ?? []).map((user) => (
            <NativeSelectOption key={user.email} value={user.email}>
              {user.email} ({user.role})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <Button type="button" onClick={() => void signIn()} disabled={!chosen}>
        Sign in
      </Button>
    </SignInLayout>
  );
}

export const devSignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/dev",
  beforeLoad: async ({ context }) => {
    // Development only: elsewhere the page does not exist, as in the Django version.
    const config = await context.queryClient.ensureQueryData(authConfigQuery).catch(() => null);
    if (!config?.devLogin) throw notFound();
    await leaveWhenSignedIn(undefined);
  },
  component: DevSignInPage,
});

/** The Django version's page for a refused sign-in. */
export const deniedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/denied",
  beforeLoad: () => {
    throw redirect({ to: "/login", search: { error: "denied" } });
  },
});
