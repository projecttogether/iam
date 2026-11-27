# Deployment

For the person who runs IAM on a Linux server, such as a VPS with Debian or
Ubuntu: [what runs](#what-runs), [setup](#setup), [health](#health), the
[first steps](#first-steps-after-the-first-sign-in),
[settings from the command line](#settings-from-the-command-line),
[read-only mode](#trying-it-with-real-data-read-only-mode),
[upgrades](#upgrades) and [builds and deploys](#builds-and-deploys). Every
environment variable is described in [Configuration](configuration.md).

## What runs

The [Deploy workflow](#builds-and-deploys) builds the image
`ghcr.io/projecttogether/iam` (linux/amd64) from every commit on `main` that
passes CI, tagged `sha-<commit>` and `latest`. There are no numbered
releases: the commit is the version. `IAM_IMAGE_TAG` in `.env` picks the
image: `latest` (the default) or `sha-<commit>` for one build.

| File                    | Contains                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command picks the role.                                       |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`) and the `worker`.                   |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own. |

| Service   | Command   | Notes                                                                                                                                                                  |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate` | `migrate` | Applies the database migrations once per deploy; web and worker wait for it. Takes over a database of the Django version ([below](#databases-of-the-django-version)). |
| `web`     | `web`     | The API and the web app on port 8000, behind a reverse proxy that terminates HTTPS.                                                                                   |
| `worker`  | `worker`  | Runs jobs, the schedule and reads from connections. One is enough; with a second, one runs jobs while the other reads a big directory.                                |

The image runs as an unprivileged user (uid 10001). `web` listens on port
8000, published on `127.0.0.1:8000` for a reverse proxy on the same
machine; `IAM_PORT` changes the host port. The app keeps everything in
PostgreSQL 16 or newer: a managed database, a server of your own, or the
container of `compose.postgres.yaml` (its volume `postgres`). The services
have no volumes of their own. Nothing else is needed: no Redis, no message
queue.

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu
24.04, run the commands as root (`sudo -i`). Point a domain name at the
server first.

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files:**

   ```sh
   git clone https://github.com/projecttogether/iam.git /srv/iam
   cd /srv/iam
   ```

3. **Register the app at your sign-in provider** with the redirect URL
   `<APP_URL>/oidc/callback/` and the address after sign-out
   `<APP_URL>/login/` ([authentication.md](authentication.md)).
4. **Create `.env`** next to `compose.yaml` with these variables, and make it
   readable for root only: `chmod 600 .env`. `.env.example` holds development
   settings; do not copy it.

   | Variable                                          | Value                                                                                                                       |
   | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
   | `APP_URL`                                         | `https://iam.example.invalid`                                                                                                   |
   | `AUTH_SECRET`                                     | random, 32+ characters: `openssl rand -base64 48`                                                                           |
   | `ENCRYPTION_KEY`                                  | `docker run --rm --log-driver none ghcr.io/projecttogether/iam cli generate-key`; keep a copy apart from the server        |
   | `DATABASE_URL`                                    | your PostgreSQL, or the container below                                                                                     |
   | `HEALTHCHECK_TOKEN`                               | optional, random: details on `/-/readyz` ([Health](#health))                                                                |
   | `KEYCLOAK_URL`, `KEYCLOAK_REALM` or `OIDC_ISSUER` | the sign-in provider ([authentication.md](authentication.md))                                                               |
   | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`            | the sign-in client                                                                                                          |
   | `BOOTSTRAP_ADMIN_EMAILS` or `OIDC_ADMIN_GROUPS`   | the first admin                                                                                                             |
   | `TZ`                                              | the time zone of dates and the schedule, e.g. `Europe/Berlin`                                                               |

5. **Database:** set `DATABASE_URL` to a PostgreSQL 16 or newer of your own
   that the containers can reach (`localhost` would be the container
   itself), or run one next to the app. For that, add to `.env`, with the
   same `openssl rand -hex 32` value in both places:

   ```sh
   COMPOSE_FILE=compose.yaml:compose.postgres.yaml
   POSTGRES_PASSWORD=REPLACE_WITH_RANDOM_HEX_PASSWORD
   DATABASE_URL=postgresql://iam:REPLACE_WITH_RANDOM_HEX_PASSWORD@postgres:5432/iam
   ```

   With `COMPOSE_FILE` in `.env`, every `docker compose` command in
   `/srv/iam` uses both files. The data lives in the volume `postgres`.

6. **Start.** The second command adds the first admin; leave it out when
   `BOOTSTRAP_ADMIN_EMAILS` or `OIDC_ADMIN_GROUPS` makes one
   ([authentication.md](authentication.md#the-first-admin)).

   ```sh
   docker compose up -d --pull always
   docker compose run --rm migrate cli create-admin --email admin@example.invalid
   ```

7. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   iam.example.invalid {
   	reverse_proxy 127.0.0.1:8000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself. With
   `IAM_PORT` set, use that port instead of 8000. The app builds every link
   and redirect from `APP_URL`, not from forwarded headers.

8. Sign in, then continue with the first steps below.

## Health

- `GET /-/healthz`: the web process answers (liveness). The web
  healthcheck in `compose.yaml` uses it.
- `GET /-/readyz`: database reachable and worker heartbeat younger than
  `WORKER_HEARTBEAT_MAX_AGE_SECONDS`; 503 otherwise. With the header
  `X-Health-Token: <HEALTHCHECK_TOKEN>` it also lists each check and the
  version.
- The worker's healthcheck in `compose.yaml` checks a file its watchdog
  touches while the worker makes progress. A stuck worker ends itself and
  the restart policy starts it again.
- The dashboard warns when the worker has not reported in time.

Nothing in the app alerts anyone when the worker stops: point an uptime
monitor (Uptime Kuma, Better Stack, a cloud provider's checks) at
`https://iam.example.invalid/-/readyz`. It answers 503 when the database is
unreachable or the worker is stale, without the token too.

`compose.yaml` gives the worker two minutes to finish the job it is running
when a deploy stops it, and web 40 seconds to finish its requests and the
emails they send ([architecture.md](architecture.md#restarts-and-deploys)).

## First steps after the first sign-in

1. **Admin › Connections:** add the directory (Keycloak, Google Workspace or a
   SCIM app), test it and import its groups. Add an email connection (SMTP)
   for initial passwords and task notifications. Leave connections off until
   the policy is ready; while a connection is off, changes there become tasks.
2. **Access profiles:** one per kind of person, with the accounts and groups
   they get. Mark the default profile per person type.
3. **Teams:** with the groups their members join.
4. **Accounts:** on each connection's page in Admin › Connections, run
   "Compare accounts now". It links existing accounts to people by work
   email or username and lists drift. An
   account whose username matches but whose email is someone else's stays
   unlinked.
5. **People:** add them, or connect Personio to import them.
6. **Admin › Settings:** onboarding lead time, automatic onboarding and
   offboarding, the daily removal limit, who gets task emails, and the person
   types other apps may request ([api.md](api.md)).
7. Turn the connections on.

Connections, Admin › Settings and API keys can also be set on the server
([Settings from the command line](#settings-from-the-command-line)).

## Settings from the command line

Everything an admin sets in **Admin › Connections**, **Admin › Settings**
and **Admin › API keys**, the teams, the access profiles and the people
can also be set on the server, without a browser, by an operator or by AI
with access to the server. The command runs the same code as the pages:
the same checks, the same encryption, the same audit log, where it appears
as `operator` with the command. The operator has an admin's rights.

```sh
docker compose run --rm -T migrate cli settings list
```

In a running container, `cli` is on the `PATH`: `docker compose exec web cli
settings list`. `cli help` lists every command.

| Command | What it does |
| --- | --- |
| `cli settings list [--json]` | Every setting: name, `set`, `not set` or `incomplete`, and hints. A secret shows as `saved` or `not saved`, never its value. |
| `cli settings show app` | Admin › Settings as JSON: the body for `apply app`. |
| `cli settings show connections` | The connections by kind. |
| `cli settings show connections --id <id>` | A connection's edit form: name, on or off, mode, settings, which secrets are saved. |
| `cli settings show connections --adapter <slug>` | An adapter's fields: names, kinds, defaults, which are required. |
| `cli settings apply app` | Saves Admin › Settings from the JSON body on stdin. |
| `cli settings apply connections` | Adds a connection from the body on stdin and prints its ID. |
| `cli settings apply connections --id <id>` | Saves a connection, as its edit form does. |
| `cli settings remove connections --id <id>` | Deletes a connection that has no jobs and no access profile. |
| `cli settings test connections --id <id>` | The "Test connection" button. |
| `cli settings import-groups connections --id <id>` | The "Import groups" button. |
| `cli settings sync connections --id <id>` | "Compare accounts now", or "Import people now" for an HR system. |
| `cli tokens create api-key --name <name>` | A new API key for another app ([api.md](api.md)): printed once, alone on stdout. Run it with `docker compose exec` ([API keys](#api-keys)). |
| `cli tokens list [--json]` | The API keys: name, first characters, created, last used, revoked. |
| `cli tokens revoke <id>` | Revokes an API key. |
| `cli groups list [--json]` | The groups teams and access profiles can grant, by connection, with their IDs. Import a connection's groups first. |
| `cli teams list [--json]` | The teams: ID, name, members, groups. |
| `cli teams show --id <id>` | A team's edit form as JSON (`name`, `description`, `groupIds`): the body for `apply`, with the groups' names to read. |
| `cli teams apply [--id <id>]` | Saves a team from the body on stdin; without `--id`, adds one. |
| `cli teams remove --id <id>` | Deletes a team. |
| `cli profiles list [--json]` | The access profiles: ID, name, people, connections, default for. |
| `cli profiles show --id <id>` | A profile's edit form as JSON (`name`, `description`, `defaultFor`, `grants` with `connectionId` and `groupIds`). |
| `cli profiles apply [--id <id>]` | Saves an access profile from the body on stdin; without `--id`, adds one. |
| `cli profiles remove --id <id>` | Deletes an access profile that nobody has. |
| `cli people …` | Print personal data: run them with `docker compose exec -T web cli people …`, since Docker keeps what `run` prints in its log. |
| `cli people list [--json]` | Everyone not archived: ID, name, work email, person type, status, team, access profile. |
| `cli people show --id <id>` | A person's edit form as JSON: the body for `apply --id`. |
| `cli people apply [--id <id>]` | Saves a person from the body on stdin; without `--id`, adds one. An empty `accessProfileId` takes the default profile of the person type. |
| `cli people start <kind> --id <id>` | Starts `onboarding`, `access_update` or `offboarding`, as the person's page does. |

Exit codes: 0 done; 1 the app refuses, with the admin page's message on
stderr; 2 a wrong command, or a body that is not JSON. After `apply`, the
command prints what `show` prints.

The rules of the admin pages apply:

- Secrets go only into the body on stdin, never into arguments: arguments
  show in `ps` and in the shell history.
- A secret left out of `secrets`, or empty, keeps the saved one. When a
  setting that says where a secret goes changes (a URL, the server, the
  port, the encryption), the body must hold the secret again.
- A new connection starts turned off. Test it, then apply its body with
  `"enabled": true`. Each save sets the status to untested, as the edit
  form does: test it again afterwards.
- Nothing needs a restart: web and worker read the settings from the
  database each time.

### `app`: Admin › Settings

Every field, as `cli settings show app` prints it. `identityRequestTypes`
are the person types other apps may request ([api.md](api.md)):

```json
{
  "organizationName": "Example",
  "automaticOnboarding": true,
  "onboardingLeadDays": 7,
  "automaticOffboarding": true,
  "removalLimitPerDay": 5,
  "notificationEmails": "it@example.invalid",
  "identityRequestTypes": ["employee", "intern"]
}
```

### `connections`: Admin › Connections

A new connection names its adapter: `keycloak`, `google_workspace`, `scim`,
`hubspot`, `slack`, `notion`, `relution`, `manual`, `personio` or `smtp`
([connections.md](connections.md) describes each). `settings` holds the
fields that are not secrets, `secrets` the secrets, each by the field name
that `cli settings show connections --adapter <slug>` lists. An edit
(`--id`) sends the same body without `adapter`. `mode` (`automatic`,
`manual`, `read_only`) counts for connections that change accounts.

```json
{
  "adapter": "smtp",
  "name": "Email",
  "enabled": false,
  "settings": {
    "host": "smtp.example.invalid",
    "port": 587,
    "security": "starttls",
    "username": "iam@example.invalid",
    "from_address": "iam@example.invalid",
    "from_name": "IT team",
    "reply_to": ""
  },
  "secrets": { "password": "REPLACE_WITH_THE_PASSWORD" }
}
```

### API keys

```sh
(umask 077; set -C; docker compose exec -T web cli tokens create api-key --name Helpdesk > helpdesk.key)
```

writes only the key into a new private file (`set -C` refuses to overwrite
one that is there already); the note with its ID and first characters goes to
stderr. Use `exec` here, not `run`: Docker's log driver
keeps what a container started with `run` prints, so the key would end up in
a log (with `journald` or a remote driver also after `--rm`).

### AI with access to the server

The secret arrives as a file: AI builds the body around it, pipes the body
into `cli settings apply`, runs `cli settings test` and deletes the file.
With `jq`, the secret stays out of arguments and out of AI's context:

```sh
jq -n --rawfile password smtp-password.txt '{
  adapter: "smtp", name: "Email", enabled: false,
  settings: { host: "smtp.example.invalid", port: 587, security: "starttls",
              username: "iam@example.invalid", from_address: "iam@example.invalid" },
  secrets: { password: ($password | rtrimstr("\n")) }
}' | docker compose run --rm -T migrate cli settings apply connections
# apply printed the new connection's ID, e.g. 3
docker compose run --rm -T migrate cli settings test connections --id 3
rm smtp-password.txt
```

## Trying it with real data: read-only mode

Start with `READ_ONLY=1` ([architecture.md](architecture.md#read-only-mode)).
The app then reads connected apps but never changes them and sends no email,
and every job only reports what it would change. A banner on every page
after sign-in shows that the mode is on.

1. Set `READ_ONLY=1` and deploy. Check `/-/readyz` with the health token:
   it answers `"read_only": true`.
2. Add the connections, turn them on, test them and import their groups.
   In read-only mode a connection that is on and automatic still only reads.
3. Build the access profiles and teams.
4. Import people. Existing staff arrive as planned; with automatic
   onboarding on (Admin › Settings), the schedule rehearses their onboarding
   within a minute and they become active in this app. Turn it off first to
   go person by person.
5. Compare accounts on each connection and review the drift. Jobs with the
   status "Checked only (read-only mode)" say what the app would do to each
   account: create, reactivate, disable or delete it, what else it would
   change there (such as the name or the sessions), and which groups it
   would add or remove. A job the connected app would refuse fails with the
   reason, as it would for real. Fix the policy or the data and rehearse again with an access
   update.

To leave read-only mode:

1. Look at Jobs › Open. Queued jobs run for real once the mode is off, and
   so do held or failed jobs that someone approves or retries. Cancel the
   workflows you do not want.
2. Consider setting connections to manual first, then to automatic one at a
   time.
3. Set `READ_ONLY=0` and redeploy web and worker.
4. Rehearsed jobs are not replayed. Start an access update for each person
   whose access should now be applied, beginning with test accounts.

## Backups

Back up the database like any PostgreSQL database, for example with
`pg_dump` from the `postgres` container:

```sh
docker compose exec -T postgres pg_dump -U iam -Fc iam > iam.dump
```

Keep `ENCRYPTION_KEY` apart from the backups: a restore needs it to read
the saved connection secrets, and the database does not hold it.

## Upgrades

Run `docker compose up -d --pull always` in `/srv/iam`: it pulls the newer
image of `IAM_IMAGE_TAG` (`latest`), runs the migrations and restarts web and
worker. `git pull` first when `compose.yaml` changed. Pull requests labeled
`breaking` describe the steps the people who run the app must take.

Migrations keep the previous image working on the migrated database: new
columns come with a database default, so going back to `sha-<commit>` of
the build before works.

## Databases of the Django version

The app was a Django app before it moved to Node.js. `migrate` takes over a
database of that version in place, in one transaction: it keeps every table
and row, adds the session table, and gives the foreign keys the rules on
delete that Django applied itself. Django's own tables stay. Each migration
also ends the sessions of the Django version. The sign-in client needs no
change: the callback stays `/oidc/callback/` and the address after sign-out
`/login/`. `DJANGO_SECRET_KEY` and `CSRF_TRUSTED_ORIGINS` still stand in for
`AUTH_SECRET` and `APP_URL` ([configuration.md](configuration.md)).

## Builds and deploys

GitHub Actions builds and deploys every commit on `main` that passes CI:

1. **CI** (`.github/workflows/ci.yaml`) runs the checks, the integration and
   end-to-end tests, and builds and starts the image.
2. **Deploy** (`.github/workflows/deploy.yml`) then builds the image with
   the commit as its version (`APP_VERSION`, the first 12 characters; shown
   under My settings › About and on `/-/readyz`), pushes
   `ghcr.io/projecttogether/iam:sha-<commit>` and `:latest`, and hands the
   image to the server of the GitHub environment `production`: over SSH as
   the user `deploy`, with the job's token, which expires with the job, and
   the app settings. The server's deploy script pulls the image, writes the
   settings, runs the migrations, starts web and worker, waits until both
   are healthy, and puts the previous image back when they do not become
   healthy.

Only the newest commit on `main` deploys: a run for an older commit, or a
rerun, deploys nothing. **Run workflow** on the Deploy workflow deploys the
current `main` again, for example after changing a setting. Without the
variable `DEPLOY_HOST`, the workflow only builds and pushes the image.

A merge to `main` goes live within minutes, so take steps that must come
first before merging.

The package `iam` in GitHub's container registry must be public, so that
servers can pull it without a token: an owner of the organization sets that
once, after the first build.

### Settings

The settings come from two places:

- **Server settings**, written on the server by its own configuration
  (ProjectTogether's infrastructure repository): `APP_URL`, `DATABASE_URL`,
  `POSTGRES_PASSWORD` with `compose.postgres.yaml`, `TZ`, `AUTH_SECRET`,
  `ENCRYPTION_KEY`, `HEALTHCHECK_TOKEN` and `READ_ONLY`, and where needed
  ports and paths (`PORT`, `HOST`, `WEB_DIST_DIR`, `MIGRATIONS_DIR`,
  `WORKER_ALIVE_FILE`) and the outbound proxy. They win over the app
  settings.
- **App settings**, sent by the Deploy workflow at each deploy from the
  environment `production`: every other variable of
  [Configuration](configuration.md) that the app reads, as the workflow's
  `SETTINGS` list names them. Empty values are left out, so the app's
  default applies. A new setting needs a line in `SETTINGS` and its own line
  below it.

| Kind      | Names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets   | `DEPLOY_SSH_KEY`, `OIDC_CLIENT_SECRET`, `SENTRY_DSN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Variables | `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `APP_URL` (the environment's link only), `OIDC_ISSUER`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `OIDC_CLIENT_ID`, `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_SIGN_ALGO`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUPS`, `OIDC_APPROVER_GROUPS`, `OIDC_VIEWER_GROUPS`, `BOOTSTRAP_ADMIN_EMAILS`, `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_USERINFO_ENDPOINT`, `OIDC_JWKS_ENDPOINT`, `SESSION_HOURS`, `SECURE_HSTS_INCLUDE_SUBDOMAINS`, `WORKER_POLL_SECONDS`, `WORKER_HEARTBEAT_MAX_AGE_SECONDS`, `WORKER_STALL_SECONDS`, `JOB_LEASE_SECONDS`, `PROVIDER_TIMEOUT_SECONDS`, `DATABASE_POOL_SIZE`, `DATABASE_STATEMENT_TIMEOUT_SECONDS`, `LOG_LEVEL`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` |

The build reads one more secret, of the repository or the organization, not
of the environment: `SENTRY_AUTH_TOKEN` ([Sentry](#error-reports-and-performance-data-sentry)).
Elsewhere, `compose.yaml` with a plain `.env` holds both kinds of settings
([Setup](#setup)).

### Rollbacks

A deploy that does not become healthy puts the previous image back by
itself. To go back by hand, revert the change on `main`, or run the server's
rollback. Neither undoes database migrations, so a migration keeps the
previous version working: add columns with a database default.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `iam@<commit>` for the
images of the Deploy workflow, unless `SENTRY_RELEASE` is set. The Deploy
workflow uploads the source maps to the Sentry project `projecttogether/iam`
when the secret `SENTRY_AUTH_TOKEN` (an organization token) is set; without
it, nothing is uploaded. Reports never contain request headers, query
strings, bodies, cookies, local variables or the calls to connected apps.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`), without personal data: requests by their route pattern, never their
query or body.
