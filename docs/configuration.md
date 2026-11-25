# Configuration

Everything an admin changes while the app runs lives in the admin section:
connections and their credentials (Admin › Connections), app users and roles
(Admin › Users and roles), lifecycle rules and notifications (Admin ›
Settings). An operator sets connections and Admin › Settings on the server
with `cli settings` too
([deployment.md](deployment.md#settings-from-the-command-line)).
Environment variables hold only what the process needs before it can read
the database, and the sign-in settings. Where each comes from when the
Deploy workflow deploys the app: [deployment.md](deployment.md#settings).

## Required in production

| Variable | Meaning |
| --- | --- |
| `APP_URL` | The public address, e.g. `https://iam.example.invalid`: `https://` in production (`http://` only for `localhost`). Links, the sign-in redirect (`/oidc/callback/`) and the check of the browser's origin come from it; on HTTPS the cookies carry the `__Host-` prefix. Without it, the one entry of `CSRF_TRUSTED_ORIGINS` (Django version) without a wildcard counts; with several such entries, set `APP_URL`. |
| `AUTH_SECRET` | Random value, at least 32 characters (`openssl rand -base64 48`). Signs the sign-in's state. Without it, `DJANGO_SECRET_KEY` (Django version) counts. |
| `ENCRYPTION_KEY` | Fernet key that encrypts connection secrets: 32 url-safe base64-encoded bytes. Create one with `cli generate-key` (`docker run --rm --log-driver none ghcr.io/projecttogether/iam cli generate-key`; without the log driver, Docker would log the key). Several comma-separated keys: the first encrypts, all decrypt (rotation below). Losing it makes the saved connection secrets unreadable. The keys of the Django version keep working. |
| `DATABASE_URL` | PostgreSQL, e.g. `postgresql://iam:password@postgres:5432/iam`. Connecting gives up after 10 seconds; TCP keepalives notice a server that went away. `sslmode` as in PostgreSQL: `require` encrypts and checks the certificate only against an `sslrootcert`, `verify-ca` checks it against `sslrootcert` but not the name, `verify-full` checks both. The CA comes only from `sslrootcert` in the URL, as a file (not `system`, `PGSSLROOTCERT` or `~/.postgresql/root.crt`; for a public CA, leave it out). `prefer` never falls back to an unencrypted connection (for a server without TLS, leave `sslmode` out), and `verify-ca` without `sslrootcert` checks like `verify-full`. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The sign-in client ([authentication.md](authentication.md)). |
| `OIDC_ISSUER` **or** `KEYCLOAK_URL` + `KEYCLOAK_REALM` | The sign-in provider. |

## Optional

| Variable | Default | Meaning |
| --- | --- | --- |
| `OIDC_PROVIDER_NAME` | `Keycloak` or `single sign-on` | Text of the sign-in button. |
| `OIDC_SCOPES` | `openid email profile` | Add `groups` if the provider needs a scope for the group claim. |
| `OIDC_SIGN_ALGO` | `RS256` | ID token signature algorithm. |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim with group names or paths. |
| `OIDC_ADMIN_GROUPS`, `OIDC_APPROVER_GROUPS`, `OIDC_VIEWER_GROUPS` | empty | Comma-separated groups that grant a role at sign-in ([authentication.md](authentication.md)). |
| `BOOTSTRAP_ADMIN_EMAILS` | empty | Verified addresses that may claim the first admin while no active admin exists. |
| `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_USERINFO_ENDPOINT`, `OIDC_JWKS_ENDPOINT` | from discovery | Only for providers without a discovery document; they win over its values. With all four set, sign-in also works when the provider has none (sign-out then stays local). |
| `SESSION_HOURS` | `12` | How long a sign-in lasts. Also the longest time a role removed at the sign-in provider still works ([authentication.md](authentication.md)). |
| `SECURE_HSTS_INCLUDE_SUBDOMAINS` | `1` | With an `https` `APP_URL`, HSTS covers subdomains too. |
| `HEALTHCHECK_TOKEN` | empty | Shows details on `/-/readyz` for requests with `X-Health-Token`. |
| `READ_ONLY` | `0` | `1`: read-only mode. The app reads connected apps but changes nothing in them and sends no email; jobs only check what they would change ([architecture.md](architecture.md#read-only-mode)). Set it for web and worker alike (`compose.yaml` does). Any value other than `1`/`0` (or `true`/`false`, `yes`/`no`, `on`/`off`) stops the app from starting. |
| `TZ` | `UTC` | Time zone for dates, start and end days, and the schedule. |
| `PORT` | `8000` | Port of the web process. |
| `HOST` | `0.0.0.0` (`127.0.0.1` with `NODE_ENV=development`) | Address the web process listens on. |
| `WORKER_POLL_SECONDS` | `5` | How often an idle worker looks for jobs. |
| `WORKER_HEARTBEAT_MAX_AGE_SECONDS` | `300` | After this, the dashboard and `/-/readyz` report the worker as stale. |
| `WORKER_STALL_SECONDS` | `600` | A worker without any progress for this long is stuck: it logs that and ends, and the container restarts it ([architecture.md](architecture.md#schedule)). |
| `JOB_LEASE_SECONDS` | `300` | A running job whose worker stopped runs again after this. |
| `PROVIDER_TIMEOUT_SECONDS` | `20` | Timeout of each call to a connected app. |
| `DATABASE_POOL_SIZE` | `10` | Connections of each process. |
| `DATABASE_STATEMENT_TIMEOUT_SECONDS` | `60` | Longest database statement of web and worker; `0`: no limit. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs are JSON lines without personal data: requests by their route pattern, never their query or body. |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | empty | Error reporting. Request headers, query strings, bodies, cookies, local variables, and calls to connected apps are excluded. The release defaults to `iam@<commit>` for the images of the Deploy workflow (`APP_VERSION`). |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Performance tracing share. |

The Caddy example in [deployment.md](deployment.md) leaves proxy access
logging off. If you enable access logs on a proxy, log the request path and
omit queries and the `Referer` header there too.

**Outbound proxy:** calls to connected apps and the sign-in provider go out
directly. To send them through a proxy, set `NODE_USE_ENV_PROXY=1` with
`HTTPS_PROXY` (and `HTTP_PROXY`, `NO_PROXY`) for `web` and `worker` (for
example in a `compose.override.yaml`): Node.js then uses them for every
outgoing request. The Django version used proxy variables without the switch.

No longer read (Django version): `ALLOWED_HOSTS`, `TRUST_PROXY_HEADERS`,
`FORWARDED_ALLOW_IPS`, `SECURE_SSL_REDIRECT`, `WEB_WORKERS`, `WEB_THREADS`,
`DJANGO_DEBUG`, `DEPLOYMENT_ENV`, `STATIC_MANIFEST`.

## Only for `compose.yaml`

| Variable | Default | Meaning |
| --- | --- | --- |
| `IAM_IMAGE_TAG` | `latest` | The image tag of `ghcr.io/projecttogether/iam`: `latest` (the newest commit on `main`) or `sha-<commit>` ([deployment.md](deployment.md#what-runs)). |
| `IAM_PORT` | `8000` | The host port of `web`, on `127.0.0.1`. |
| `COMPOSE_FILE` | `compose.yaml` | `compose.yaml:compose.postgres.yaml` adds a PostgreSQL container, with `POSTGRES_PASSWORD`. |

## Development only

| Variable | Meaning |
| --- | --- |
| `NODE_ENV=development` | Development mode (`.env.example`). Without `ENCRYPTION_KEY`, a key is derived from the development secret; without `AUTH_SECRET`, a development secret is used. The image sets `NODE_ENV=production`. |
| `DEV_LOGIN=1` | Sign in as any app user without a provider (`/login/dev`). Refused unless `NODE_ENV=development`. |

## Rotating the encryption key

1. Create a new key: `docker compose exec -T web cli generate-key`.
2. Set `ENCRYPTION_KEY=<new>,<old>` and redeploy.
3. Run `docker compose run --rm migrate cli rotate-secrets` once.
4. Set `ENCRYPTION_KEY=<new>` and redeploy.
