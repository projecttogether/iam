# Contributing

IAM is a Hono server and a React web app in one repository (npm
workspaces). `AGENTS.md` has the layout and the rules; this file has the
setup and the checks.

## Development setup

Requirements: Node.js 26 and Docker with Compose.

```sh
docker compose -f compose.dev.yaml up -d
cp .env.example .env
npm ci
npm run db:migrate
npm run dev                              # http://localhost:5173
```

`compose.dev.yaml` runs the services the app talks to (`DEV_POSTGRES_PORT`,
`DEV_KEYCLOAK_PORT`, `DEV_SMTP_PORT` and `DEV_MAILPIT_PORT` move them when
another stack uses the ports):

| Service       | Address                                      | Login                                                                                     |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| PostgreSQL 18 | `localhost:55438`, database `iam`            | `iam` / `iam`                                                                             |
| Keycloak 26   | http://localhost:8098                        | console `admin` / `admin`; realm `iam`, user `admin` / `admin` (member of `/iam/admins`) |
| Mailpit       | http://localhost:8027, SMTP `localhost:1027` | none                                                                                      |

The realm (`dev/keycloak/iam-realm.json`) has the sign-in client `iam`
(secret `iam-dev-client-secret`, with a group claim), the provisioning client
`iam-provisioner` (secret `iam-dev-provisioner-secret`, service account with
the realm-management roles and the `kc-admin-api` scope the Keycloak
connection needs), groups under `/apps`, `/teams` and `/iam`, and sends its
emails to Mailpit.

`npm run dev` starts the server (API, sign-in, worker; port 8000, reloads on
changes) and Vite with the web app on port 5173, which passes `/api`,
`/oidc` and `/-/` on to the server. The server reads `.env`; `APP_URL` is
Vite's address, which the development realm allows as a sign-in redirect.

To try the app with the development Keycloak as a connection: Admin ›
Connections › Add › Keycloak with URL `http://localhost:8098`, realm `iam`,
client `iam-provisioner` and its secret. For email: Email (SMTP), host
`localhost`, port `1027`, security none.

`npm run cli -- seed-demo` adds demo people, profiles, teams and a manual
app. Without Keycloak, set `DEV_LOGIN=1` in `.env` and sign in at
`/login/dev` as any app user (development mode only). Other commands:
`generate-key`, `create-admin --email <address>`, `rotate-secrets`, and
`settings list` (`cli help` lists them all).

## Checks

```sh
node scripts/check-public-repository.mjs
npm run lint
npm run format:check
npm run typecheck
npm test                                                   # unit tests
TEST_DATABASE_URL=postgres://iam:iam@localhost:55438/iam_test npm run test:integration
npm run db:generate                                        # must leave apps/server/drizzle unchanged
npm run build
```

Integration tests recreate the database of `TEST_DATABASE_URL`. Adapters are
tested against fake HTTP answers (`src/test/mock-fetch.ts`); the engine
against an in-memory adapter (`src/test/fake-adapter.ts`). One test takes over
a database of the Django version (`src/db/fixtures/django-0.2.sql`) and checks
that it ends with the schema of a new one.

CI (`.github/workflows/ci.yaml`) runs these, scans the history for secrets,
builds the image and starts it with `compose.yaml`, and runs the end-to-end
check below against the image.

### End-to-end check

`tests/browser/e2e.mjs` drives a browser through the real flow against the
local stack: sign-in through Keycloak, Keycloak and SMTP connections set up in
the admin section, a profile, a team and a person, onboarding (it checks the
Keycloak user, its groups and the setup email in Mailpit), offboarding (user
disabled, managed groups gone), account comparison and sign-out. It needs
the app on port 8000 (the redirect URL of the development realm) and a
running worker. `KEYCLOAK_URL`, `MAILPIT_URL` and `SMTP_PORT` follow moved
ports.

```sh
cd tests/browser && npm ci && npx playwright install chromium && cd ../..
node tests/browser/e2e.mjs          # screenshots in test-results/
```

## Database changes

Change the schema in `apps/server/src/db/schema.ts`, run
`npm run db:generate`, and commit the new file in `apps/server/drizzle/`.
Keep the table, column, constraint and index names of the Django version for
existing tables, and give a new column of an existing table a database
default: the previous version must keep working on the migrated database (a
deploy that fails puts it back).

## Pull requests

Write the title as one plain line of what changes. Label a pull request
`breaking` when the people who run the app must act on it, and describe the
steps in it. Update the docs when behavior or configuration changes.

## Builds and deploys

Every commit on `main` that passes CI is built and deployed; there are no
releases ([docs/deployment.md](docs/deployment.md#builds-and-deploys)). The
Deploy workflow uploads the source maps to the Sentry project
`projecttogether/iam` with the secret `SENTRY_AUTH_TOKEN` (Dockerfile);
without the secret, it uploads nothing.

## Data, secrets and privacy

Never commit secrets, real personal data or data from a real organization,
also not in tests and fixtures. Use `example.invalid` addresses and invented
content. `scripts/check-public-repository.mjs` rejects private file types,
unknown hosts and email domains, internal names and token formats; add a
host there only when it is public and intended. `.gitleaks.toml` lists the
invented keys of the tests.
