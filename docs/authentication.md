# Sign-in and roles

The sign-in provider proves who someone is. The app's own users decide what
they may do: a person signs in only when an active app user exists for them.

## Roles

| Role | May |
| --- | --- |
| Viewer | Read everything outside the admin section. |
| Approver | Also add and edit people, start onboarding, access updates and offboarding, retry jobs, complete and cancel tasks. |
| Admin | Also manage access profiles and teams, approve held removals, and use the admin section: connections, users and roles, settings. |

An app user can be linked to a person. Starting that person's offboarding
turns the app user off at once. Because of that, only someone with the same
or a higher role can start it: an approver cannot offboard an admin of this
app. The same role rule applies to changing a person's end date. The
schedule starts offboarding after the end date currently on record has passed.

## Any OpenID Connect provider

1. Create a confidential client with the authorization code flow.
   - Redirect URI: `https://<host>/oidc/callback/`
   - Post-logout redirect URI: `https://<host>/login/`
   - PKCE (S256) is used; allow it if the provider asks.
2. Set `OIDC_ISSUER` (the issuer URL; the app reads
   `<issuer>/.well-known/openid-configuration`), `OIDC_CLIENT_ID` and
   `OIDC_CLIENT_SECRET`. Optionally `OIDC_PROVIDER_NAME` for the button.
3. The provider must send `email` and `email_verified`; the app links an app
   user added by email only to a verified address.

The app checks the ID token's signature (keys from the provider's JWKS),
issuer and audience. Sign-out ends the provider session when the provider
publishes a valid `end_session_endpoint`. The app checks the discovery
document's issuer and sign-in endpoints before caching it. If the provider
returns invalid sign-in metadata, the app shows a sign-in unavailable page.

## Keycloak

Set `KEYCLOAK_URL` (without `/realms/...`) and `KEYCLOAK_REALM` instead of
`OIDC_ISSUER`. In the realm:

1. Create a client, e.g. `iam`: client authentication on, standard flow on,
   direct access grants off. Valid redirect URI `https://<host>/oidc/callback/`,
   valid post logout redirect URI `https://<host>/login/`.
2. For roles from groups, add a mapper to the client (Client scopes ›
   `iam-dedicated` › Add mapper › By configuration › Group Membership): token
   claim name `groups`, full group path on, add to ID token and userinfo.
3. Set `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the client's
   credentials tab.

People then find a link to Keycloak's account console on their settings page
(Settings in the user menu, card "Account").

Signing in and managing Keycloak accounts are separate: the Keycloak
*connection* in the admin section uses its own service-account client
([connections.md](connections.md)).

## The first admin

Choose one:

- `docker compose run --rm migrate cli create-admin --email admin@example.invalid` adds an admin
  app user. The first sign-in with that verified address links it.
- `BOOTSTRAP_ADMIN_EMAILS=admin@example.invalid`: a sign-in with that
  verified address creates an admin, but only while no active admin exists.
- Group claims (below).

After that, admins add users in Admin › Users and roles.

## Roles from group claims

Set any of `OIDC_ADMIN_GROUPS`, `OIDC_APPROVER_GROUPS`, `OIDC_VIEWER_GROUPS`
(comma-separated). A value must be the group exactly as the provider sends it:
the name, or for Keycloak with full paths the path (`/iam/admins`). A name
without a slash also matches the top-level group of that name (`admins`
matches `/admins`), but never a group further down (`/sales/admins`): give
the full path for those. Then:

- A first sign-in with a verified email and a matching group creates the
  app user with that role (the highest role wins).
- Each sign-in updates the role of users whose role came from a group claim.
  Without a matching group, such a user is turned off, and stays off when
  the group comes back: an admin turns them on again in Admin › Users and
  roles. (Offboarding or an admin may have turned them off; a group claim
  never overrides that.) Role changes and turning off are audited.
- Users an admin added or changed in the app keep their role; group claims
  do not change them.

Group claims are read only at sign-in. Someone removed from a group at the
provider, or turned off there, keeps their role in this app until their
sign-in ends, at most `SESSION_HOURS` (12 by default). To end it at once,
turn the user off in Admin › Users and roles. Set a lower `SESSION_HOURS`
when that delay is too long for you.
