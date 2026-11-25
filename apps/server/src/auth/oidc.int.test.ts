import { createHash, createSecretKey } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config, overrideConfigForTests, resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { createApp } from "../http/app";
import { createUser, request, resetDatabase, testApp } from "../test/helpers";
import {
  claims,
  DISCOVERY,
  DISCOVERY_URL,
  ISSUER,
  rsaKey,
  setCookie,
  signIn,
  useFakeProvider,
  type FakeProvider,
} from "../test/fake-provider";
import { discovery, providerLogoutUrl, ProviderUnavailable, resetDiscoveryCache } from "./oidc";
import { unsign } from "./session";

/**
 * Port of tests/test_auth.py, the provider side: discovery, the sign-in
 * redirects, the ID token and user info checks, and sign-out. The Django
 * version answered a provider it could not use with a 503 page; this
 * version sends the browser to the sign-in page with `?error=unavailable`
 * (and `?error=denied` where Django went to /login/denied/).
 */

const MAX_REDIRECT_LENGTH = 2048;
const UNAVAILABLE = "/login?error=unavailable";
const DENIED = "/login?error=denied";

let provider: FakeProvider;
let restore: () => void;

const authenticate = (headers: Record<string, string> = {}) =>
  testApp().request("/oidc/authenticate/", { headers });

/** Answers discovery with these documents in turn (then the last one again). */
function discoveryAnswers(...documents: unknown[]) {
  provider.discovery = () => (documents.length > 1 ? documents.shift() : documents[0]);
}

const sessionCookie = (token: string) => ({ cookie: `iam_session=${token}` });

describe("sign-in with OpenID Connect", () => {
  beforeAll(() => {
    ({ provider, restore } = useFakeProvider());
  });
  afterAll(() => restore());

  beforeEach(async () => {
    await resetDatabase();
    resetConfigForTests();
    resetDiscoveryCache();
    provider.discovery = DISCOVERY;
    provider.userInfo = claims();
    provider.idToken = {};
    provider.requests.length = 0;
  });

  // -- discovery ---------------------------------------------------------------------

  it("fetches the discovery document once and caches it", async () => {
    expect((await discovery()).token_endpoint.endsWith("/token")).toBe(true);
    await discovery();
    expect(provider.requests).toEqual([DISCOVERY_URL]);
  });

  it("refuses a discovery document of another issuer", async () => {
    provider.discovery = { ...DISCOVERY, issuer: "https://evil.example.invalid" };
    await expect(discovery()).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  const { jwks_uri: _jwks, ...withoutJwks } = DISCOVERY;
  it.each([
    ["no object", []],
    ["no issuer", { ...DISCOVERY, issuer: null }],
    ["no token endpoint", { ...DISCOVERY, token_endpoint: null }],
    ["a relative user info endpoint", { ...DISCOVERY, userinfo_endpoint: "/userinfo" }],
    ["a lone surrogate", { ...DISCOVERY, authorization_endpoint: `${ISSUER}/\ud800` }],
    [
      "a label starting with a hyphen",
      { ...DISCOVERY, token_endpoint: "https://-sso.example.invalid/token" },
    ],
    ["a symbol IDNA 2008 refuses", { ...DISCOVERY, token_endpoint: "https://☕.example.invalid/token" }],
    [
      "a sign-in URL over the redirect limit",
      { ...DISCOVERY, authorization_endpoint: `${ISSUER}/${"a".repeat(MAX_REDIRECT_LENGTH)}` },
    ],
    ["an invalid port", { ...DISCOVERY, jwks_uri: "https://sso.example.invalid:invalid/keys" }],
    ["no signing keys", withoutJwks],
  ])(
    "answers an invalid discovery document (%s) with the unavailable page and tries again",
    async (_, document) => {
      discoveryAnswers(document, DISCOVERY);
      const first = await authenticate();
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe(UNAVAILABLE);
      expect(setCookie(first, "iam_oidc")).toBeUndefined();
      const second = await authenticate();
      expect(second.status).toBe(302);
      expect(second.headers.get("location")!.startsWith(DISCOVERY.authorization_endpoint)).toBe(true);
    },
  );

  it("takes a missing endpoint from a setting", async () => {
    provider.discovery = { ...DISCOVERY, token_endpoint: null };
    overrideConfigForTests({ OIDC_TOKEN_ENDPOINT: `${ISSUER}/override` });
    expect((await discovery()).token_endpoint).toBe(`${ISSUER}/override`);
  });

  it("needs no signing keys for symmetric signing", async () => {
    overrideConfigForTests({ OIDC_SIGN_ALGO: "HS256" });
    provider.discovery = withoutJwks;
    expect((await discovery()).authorization_endpoint).toBe(DISCOVERY.authorization_endpoint);
  });

  it("answers a sign-in URL over the redirect limit with the unavailable page", async () => {
    provider.discovery = {
      ...DISCOVERY,
      authorization_endpoint: `${ISSUER}/`.padEnd(MAX_REDIRECT_LENGTH, "a"),
    };
    const response = await authenticate();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UNAVAILABLE);
  });

  it.each([["/logout"], [`${ISSUER}/\ud800`], [`${ISSUER}/`.padEnd(MAX_REDIRECT_LENGTH, "a")]])(
    "keeps sign-in available and signs out locally with an invalid sign-out endpoint (%#)",
    async (badLogout) => {
      provider.discovery = { ...DISCOVERY, end_session_endpoint: badLogout };
      expect((await authenticate()).status).toBe(302);
      expect(
        (await authenticate()).headers.get("location")!.startsWith(DISCOVERY.authorization_endpoint),
      ).toBe(true);
      expect(await providerLogoutUrl("id-token")).toBe(`${config().APP_URL}/login/`);
    },
  );

  it("works without discovery when every endpoint is set", async () => {
    provider.discovery = new TypeError("fetch failed");
    overrideConfigForTests({
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_USERINFO_ENDPOINT: `${ISSUER}/userinfo`,
      OIDC_JWKS_ENDPOINT: `${ISSUER}/certs`,
    });
    expect((await discovery()).token_endpoint).toBe(`${ISSUER}/token`);
    overrideConfigForTests({ OIDC_JWKS_ENDPOINT: "" });
    await expect(discovery()).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("signs in without discovery with the issuer as configured, slash and all", async () => {
    await createUser("viewer", "ada@example.invalid");
    provider.userInfo = claims();
    provider.discovery = new Response("", { status: 404 });
    provider.idToken = { claims: { iss: `${ISSUER}/` } };
    overrideConfigForTests({
      oidcIssuerConfigured: `${ISSUER}/`,
      OIDC_AUTHORIZATION_ENDPOINT: DISCOVERY.authorization_endpoint,
      OIDC_TOKEN_ENDPOINT: DISCOVERY.token_endpoint,
      OIDC_USERINFO_ENDPOINT: DISCOVERY.userinfo_endpoint,
      OIDC_JWKS_ENDPOINT: DISCOVERY.jwks_uri,
    });
    const { location, session } = await signIn(provider);
    expect(location).toBe("/");
    expect(session).toBeTruthy();
  });

  it("keeps the sign-out of a discovery document when endpoints are set", async () => {
    overrideConfigForTests({
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_USERINFO_ENDPOINT: `${ISSUER}/userinfo`,
      OIDC_JWKS_ENDPOINT: `${ISSUER}/certs`,
    });
    const document = await discovery();
    expect(document.token_endpoint).toBe(`${ISSUER}/token`);
    expect(document.end_session_endpoint).toBe(DISCOVERY.end_session_endpoint);
  });

  it.each([
    ["invalid JSON", () => new Response("{not json", { headers: { "content-type": "application/json" } })],
    [
      "JSON too deep to read",
      () =>
        Object.assign(new Response("{}"), {
          json: async () => {
            throw new RangeError("Maximum call stack size exceeded");
          },
        }),
    ],
  ])("does not let explicit endpoints hide a discovery document of %s", async (_, answer) => {
    overrideConfigForTests({
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_USERINFO_ENDPOINT: `${ISSUER}/userinfo`,
      OIDC_JWKS_ENDPOINT: `${ISSUER}/certs`,
    });
    provider.discovery = answer;
    const response = await authenticate();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UNAVAILABLE);
  });

  // -- the sign-in -------------------------------------------------------------------

  it("sends the browser to the provider with PKCE, a state and a nonce", async () => {
    const response = await authenticate();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.href.startsWith(DISCOVERY.authorization_endpoint)).toBe(true);
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("client_id")).toBe("iam");
    expect(location.searchParams.get("redirect_uri")).toBe(`${config().APP_URL}/oidc/callback/`);
  });

  it("shows the unavailable page while the provider is down", async () => {
    provider.discovery = new TypeError("fetch failed", { cause: new Error("down") });
    const response = await authenticate();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UNAVAILABLE);
  });

  it("signs in with a session cookie that /api/v1/me accepts", async () => {
    const user = await createUser("approver", "ada@example.invalid");
    provider.userInfo = claims({ name: "Ada Lovelace" });
    const { callback, location, session } = await signIn(provider, { next: "/people" });
    expect(callback.status).toBe(302);
    expect(location).toBe("/people");
    expect(session).toBeTruthy();
    const cookie = callback.headers.getSetCookie().findLast((line) => line.startsWith("iam_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // The state is used once.
    expect(setCookie(callback, "iam_oidc")).toBe("");

    const me = await request("GET", "/api/v1/me", { headers: sessionCookie(session!) });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      id: user.id,
      email: "ada@example.invalid",
      name: "Ada Lovelace",
      role: "approver",
    });
    const [bound] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(bound!.oidcSubject).toBe("subject-1");
    expect(bound!.lastLogin).not.toBeNull();
  });

  it("exchanges the code for the callback URL of APP_URL, wherever a proxy forwards the callback", async () => {
    overrideConfigForTests({ APP_URL: "http://iam.example.invalid" });
    await createUser("viewer", "ada@example.invalid");
    provider.userInfo = claims();
    const { callback, session } = await signIn(provider, {
      callbackOrigin: "http://web.example.invalid:8000",
    });
    expect(callback.headers.get("location")).toBe("/");
    expect(session).toBeTruthy();
    expect(provider.lastTokenRequest?.get("redirect_uri")).toBe("http://iam.example.invalid/oidc/callback/");
  });

  it("signs one user in several times at once", async () => {
    await createUser("viewer", "ada@example.invalid");
    provider.userInfo = claims();
    const signIns = await Promise.all(Array.from({ length: 8 }, () => signIn(provider)));
    expect(signIns.map(({ location }) => location)).toEqual(Array(8).fill("/"));
    expect(signIns.every(({ session }) => session)).toBe(true);
    expect(await getDb().$count(sessions)).toBe(8);
  });

  it("goes back only to a path of this app after sign-in", async () => {
    await createUser("viewer", "ada@example.invalid");
    for (const next of [
      "https://evil.example.invalid/",
      "//evil.example.invalid/",
      "/\\evil.example.invalid",
    ]) {
      expect((await signIn(provider, { next })).location).toBe("/");
    }
  });

  it("lets nobody in without an active app user", async () => {
    const { location, session } = await signIn(provider);
    expect(location).toBe(DENIED);
    expect(session).toBeUndefined();
    expect(await getDb().select().from(users)).toEqual([]);
  });

  it("refuses ID tokens of another issuer or client, and expired ones", async () => {
    await createUser("viewer", "ada@example.invalid");
    const accepted = async (extra: Record<string, unknown>) => {
      provider.idToken = { claims: extra };
      return Boolean((await signIn(provider)).session);
    };
    expect(await accepted({})).toBe(true);
    // Several audiences: OpenID Connect wants the authorized party to be this client.
    expect(await accepted({ aud: ["other", "iam"], azp: "iam" })).toBe(true);
    expect(await accepted({ aud: "other" })).toBe(false);
    expect(await accepted({ aud: ["other", "iam"], azp: "other" })).toBe(false);
    expect(await accepted({ iss: "https://evil.example.invalid" })).toBe(false);
    expect(await accepted({ exp: Math.floor(Date.now() / 1000) - 30 })).toBe(true); // within the allowed clock difference
    for (const exp of [Math.floor(Date.now() / 1000) - 3600, undefined, "tomorrow"]) {
      expect(await accepted({ exp }), String(exp)).toBe(false);
    }
  });

  it("allows the clock difference on signed ID tokens, and checks the signature and algorithm", async () => {
    await createUser("viewer", "ada@example.invalid");
    const accepted = async (idToken: FakeProvider["idToken"]) => {
      provider.idToken = idToken;
      return Boolean((await signIn(provider)).session);
    };
    const now = () => Math.floor(Date.now() / 1000);
    const ahead = now() + 30;
    expect(await accepted({})).toBe(true);
    expect(await accepted({ claims: { iat: ahead, nbf: ahead } })).toBe(true);
    expect(await accepted({ claims: { exp: now() - 30 } })).toBe(true);
    expect(await accepted({ claims: { exp: now() - 3600 } })).toBe(false);
    expect(await accepted({ claims: { iat: now() + 3600 } })).toBe(false);
    expect(await accepted({ key: rsaKey() })).toBe(false);
    expect(await accepted({ algorithm: "RS512" })).toBe(false);
    expect(await accepted({ raw: "" })).toBe(false);
    overrideConfigForTests({ OIDC_SIGN_ALGO: "RS512" });
    resetDiscoveryCache();
    expect(await accepted({ algorithm: "RS512" })).toBe(true);
  });

  it("checks the signature of a symmetric ID token with the client secret", async () => {
    await createUser("viewer", "ada@example.invalid");
    overrideConfigForTests({ OIDC_SIGN_ALGO: "HS256" });
    resetDiscoveryCache();
    const accepted = async (secret: string, algorithm = "HS256") => {
      provider.idToken = { algorithm, key: createSecretKey(Buffer.from(secret)) };
      return Boolean((await signIn(provider)).session);
    };
    expect(await accepted(config().OIDC_CLIENT_SECRET)).toBe(true);
    expect(await accepted("another-secret")).toBe(false);
    expect(await accepted(config().OIDC_CLIENT_SECRET, "HS512")).toBe(false);
  });

  it("takes user info only about the subject of the ID token", async () => {
    const user = await createUser("viewer", "ada@example.invalid");
    provider.userInfo = claims({ sub: "someone-else" });
    const { location, session } = await signIn(provider);
    expect(location).toBe(DENIED);
    expect(session).toBeUndefined();
    const [unbound] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect(unbound!.oidcSubject).toBeNull();
  });

  it("keeps the current session on a sign-in error without a matching state", async () => {
    await createUser("admin", "ada@example.invalid");
    const { session } = await signIn(provider);
    // A sign-in started in this browser and still pending.
    const pending = await authenticate({ cookie: `iam_session=${session}` });
    const stateCookie = setCookie(pending, "iam_oidc")!;
    const pendingState = new URL(pending.headers.get("location")!).searchParams.get("state");

    const response = await testApp().request("/oidc/callback/?error=access_denied&state=unrelated", {
      headers: { cookie: `iam_session=${session}; iam_oidc=${stateCookie}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DENIED);
    expect((await request("GET", "/api/v1/me", { headers: sessionCookie(session!) })).status).toBe(200);
    const kept = unsign<{ state: string }[]>(setCookie(response, "iam_oidc") ?? stateCookie) ?? [];
    expect(kept.map((item) => item.state)).toContain(pendingState);
  });

  // -- sessions and sign-out -------------------------------------------------------------

  it("signs out users that were turned off", async () => {
    const user = await createUser("viewer", "ada@example.invalid");
    const token = "a-session-token";
    await getDb()
      .insert(sessions)
      .values({
        id: createHash("sha256").update(token).digest("hex"),
        userId: user.id,
        expiresAt: new Date(Date.now() + 3600_000),
      });
    expect((await request("GET", "/api/v1/me", { headers: sessionCookie(token) })).status).toBe(200);
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, user.id));
    expect((await request("GET", "/api/v1/me", { headers: sessionCookie(token) })).status).toBe(401);
  });

  it("ends the provider's session at sign-out", async () => {
    const url = await providerLogoutUrl("id-token");
    expect(url.startsWith(`${DISCOVERY.end_session_endpoint}?`)).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get("id_token_hint")).toBe("id-token");
    expect(query.get("client_id")).toBe("iam");
    expect(query.get("post_logout_redirect_uri")).toBe(`${config().APP_URL}/login/`);
  });

  it("signs out of the app and the provider with the session's ID token", async () => {
    await createUser("viewer", "ada@example.invalid");
    const { session } = await signIn(provider);
    const response = await request("POST", "/api/v1/auth/logout", { headers: sessionCookie(session!) });
    expect(response.status).toBe(200);
    const redirect = new URL(response.body.redirect);
    expect(redirect.href.startsWith(DISCOVERY.end_session_endpoint)).toBe(true);
    expect(redirect.searchParams.get("id_token_hint")!.split(".")).toHaveLength(3);
    expect((await request("GET", "/api/v1/me", { headers: sessionCookie(session!) })).status).toBe(401);
  });

  it("keeps the provider's own query in the sign-out URL", async () => {
    provider.discovery = { ...DISCOVERY, end_session_endpoint: `${ISSUER}/logout?tenant=team` };
    const query = new URL(await providerLogoutUrl("id-token")).searchParams;
    expect(query.getAll("tenant")).toEqual(["team"]);
    expect(query.getAll("client_id")).toEqual(["iam"]);
    expect(query.getAll("id_token_hint")).toEqual(["id-token"]);
  });

  // -- pages ------------------------------------------------------------------------------

  it("needs a sign-in for everything but the sign-in page and the health check", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "iam-web-"));
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>IAM</title>");
    overrideConfigForTests({ WEB_DIST_DIR: dist });
    const app = createApp();
    expect((await request("GET", "/api/v1/people")).status).toBe(401);
    expect((await request("GET", "/api/v1/me")).status).toBe(401);
    expect((await request("GET", "/api/v1/auth-config")).status).toBe(200);
    expect((await app.request("/login", { headers: { accept: "text/html" } })).status).toBe(200);
    expect((await app.request("/-/healthz")).status).toBe(200);
  });

  it("has no development sign-in unless it is switched on", async () => {
    await createUser("admin");
    expect((await request("GET", "/api/v1/auth/dev-users")).status).toBe(404);
    const login = await request("POST", "/api/v1/auth/dev-login", {
      body: { email: "admin@example.invalid" },
    });
    expect(login.status).toBe(404);
    expect(login.headers.getSetCookie().some((line) => line.startsWith("iam_session="))).toBe(false);
  });
});
