# AGENTS.md

IAM is ProjectTogether's open-source identity and access management app: a
TypeScript app (Node.js 26, PostgreSQL) that manages people, access
profiles, teams and their accounts in connected apps. User documentation is
in `docs/`; contributor setup is in `CONTRIBUTING.md`; the domain language is
in `CONTEXT.md`; how it works inside is in `docs/architecture.md`.

## Stack

npm workspaces, strict TypeScript.

- `apps/server`: Hono (API under `/api/v1`, the API for other apps under
  `/api/integration/v1`, sign-in under `/oidc`), Drizzle ORM on PostgreSQL,
  openid-client, nodemailer, pino logs, Sentry, Vitest.
- `apps/web`: Vite + React 19, TanStack Router and Query, Tailwind CSS 4.
  `src/components/ui/` holds the components (shadcn/ui and Radix), the app
  frame, the page layout, the sign-in page and the theme with
  ProjectTogether's colors (`styles.css`); `src/components/brand.tsx` the app
  icon and ProjectTogether's logo. US English.
- `packages/shared` (`@iam/shared/*`): API types and request schemas
  (`api/iam.ts`), labels of the choices (`labels.ts`), error-report
  redaction.

One image, three processes: `migrate`, `web` and `worker` (`APP_ROLE`,
`docker-entrypoint.sh`); its command `cli …` runs the operator commands.

## Layout

```
apps/server/src/
  main.ts          entry; APP_ROLE selects the processes; a stop waits for the running work
  cli.ts           entry of the operator commands; cli/ has the settings and tokens
  config.ts        every environment variable (zod); read only via config()
  db/              Drizzle schema (schema.ts), migrations, transactions (tx.ts),
                   the takeover of a database of the Django version (django.ts)
  auth/            OpenID Connect sign-in, sessions, roles from claims
  adapters/        one module per connected app, registered in registry.ts
  engine/          policy, lifecycle, jobs, accounts, sync, schedule, identity requests
  worker/          the worker loop and its watchdog
  core/            encryption, background work after an answer
  http/            app factory, middleware, errors, sign-in routes
  modules/         one file per API area: routes
apps/web/src/      web app; modules/<area> holds each area's pages; app/navigation.ts
                   the sidebar, its keys and the breadcrumbs of the frame (AppFrame)
packages/shared/src/  contracts, labels
scripts/           build helpers, the public repository check
tests/browser/     the end-to-end check (Playwright)
```

## Rules

- **Adapters** live in `apps/server/src/adapters/`, one module per connected
  app, registered in `registry.ts`. They get their configuration as an
  object, never touch the database, and never put secrets or provider
  responses into error messages. What a job does at an account is decided
  from reads in the adapter's plan (`planEnsure`, `planDisable`,
  `planGroups`); the job follows it and read-only mode rehearses it, so put a
  new decision or refusal there, not in `ensureAccount` or `setActive` alone.
  Connection settings are configured in the admin UI, not in environment
  variables.
- **The engine** (`apps/server/src/engine/`): `policy.ts` (desired access),
  `lifecycle.ts` (starting and cancelling workflows), `jobs.ts` (running
  jobs; the only place that changes job, task and workflow status: `runJob`
  is `attempt`, which talks to the connection and writes nothing, then
  `finish`, the only code that settles a claimed job), `accounts.ts` (the
  only writer of Account rows), `sync.ts` (reads), `schedule.ts`.
  Transactions go through `db/tx.ts` (`atomic`, `q()`, `onCommit`); keep the
  lock order person, then job or workflow.
- **The API for other apps** (`/api/integration/v1`, `docs/api.md`) is a
  contract: Helpdesk sends identity requests with an API key and reads them
  back. Change it only in ways existing clients survive.
- **Restarts:** a deploy may restart `web` and `worker` at any time. The
  worker finishes its job on SIGTERM; a job cut short runs again after its
  lease, so its steps read first and are idempotent. Work after an answer
  (an email) goes through `runInBackground` (`core/background.ts`), which a
  stop waits for (`docs/architecture.md`, Restarts and deploys).
- **Secrets** (connection credentials) are stored encrypted with
  `ENCRYPTION_KEY` (Fernet), never returned (the API shows hints) and never
  logged. API keys are stored as SHA-256.
- **Settings** of the admin pages are saved by service functions that the
  routes and the operator commands (`cli/`) both call. The command takes
  secrets only on stdin.
- **Environment variables:** document each in `docs/configuration.md`. An
  app setting (not one of the server settings in `docs/deployment.md`,
  Settings) also needs a line in the Deploy workflow's `SETTINGS`.
- **Audit:** every change by a person or the worker writes an audit event
  without secret values.
- **Logging:** `logger` with ids and codes; never personal data or secrets.
  No `console.*`, no `any`.
- **Design:** ProjectTogether's colors and app identity (PT Sky for buttons,
  focus and selected states, with PT Ocean text on it; links in the darker
  `--link`); the tokens are in `apps/web/src/components/ui/styles.css`.
  Secrets use `SecretField`/`SecretInput`. Keep components close to
  shadcn/ui.

## Database

The database keeps the table, column, constraint and index names of the
Django version (`db/schema.ts`); `db/django.ts` takes over a Django database
in place. Change the schema in `apps/server/src/db/schema.ts`, then run
`npm run db:generate` and commit the migration; CI fails when they differ.
The running installation's database must keep working: add columns to
existing tables with a database default, so the previous version still runs
after a rollback, and keep stored values (setting keys, enum values, kinds).

## Checks

```sh
node scripts/check-public-repository.mjs
npm run lint && npm run format:check && npm run typecheck
npm test                                                   # unit tests
TEST_DATABASE_URL=postgres://iam:iam@localhost:55438/iam_test npm run test:integration
npm run db:generate                                        # must leave apps/server/drizzle unchanged
npm run build
```

The end-to-end check (`tests/browser/e2e.mjs`) needs the development stack
(`compose.dev.yaml`), the app on port 8000 and a worker; see
`CONTRIBUTING.md`. CI runs everything above on every pull request.

Deploys: every commit on `main` that passes CI is built and deployed
(`docs/deployment.md`, Builds and deploys). No file holds the version.

## Content

UI text and messages are in US English; short and plain. Never commit
secrets, real personal data or data from a real organization: use
`example.invalid` addresses and invented content. Keep ProjectTogether's
internals (server names, addresses, internal domains, people, vault names)
out of this repository; they belong in its infrastructure repository. The
repository is public and licensed under the Apache License 2.0 (`LICENSE`).
