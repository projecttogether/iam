# Connections

A connection links IAM to one app or service. Admins add, test and
change connections in **Admin > Connections**; an operator does the same on
the server with `cli settings` ([deployment.md](deployment.md#settings-from-the-command-line)).
Every setting lives in the database; no connection needs an environment
variable.

## How connections work

### Kinds

| Kind | What it does | Adapters |
| --- | --- | --- |
| Accounts and groups | Creates, updates and disables accounts and their group memberships | Keycloak, Google Workspace, SCIM 2.0, HubSpot, Slack, Notion, Relution, Other app (manual tasks) |
| People import | Reads people from an HR system | Personio |
| Email | Sends task notifications and initial passwords | Email (SMTP) |

### Modes

Accounts-and-groups connections that can write have a mode:

| Mode | Effect |
| --- | --- |
| Automatic | The worker makes each change through the app's API. |
| Manual | Each change becomes a task with step-by-step instructions. Completing the task records the change. |
| Read only | The app compares accounts but never changes them. Each change becomes a task. |

Slack, Notion and "Other app" never write, so their changes are always tasks.

### Turning a connection on and off

A new connection starts turned off. Test it, then turn it on.

- The app changes nothing at a turned-off connection, and the schedule does
  not read it.
- Onboarding and access updates skip it.
- Offboarding still plans a step for it, as a manual task, wherever the person
  has a known account or the access profile grants one. A job that was already
  queued when the connection was turned off also becomes a manual task. The
  app never skips a removal silently.

### Secrets

Secret fields (tokens, passwords, keys) are stored encrypted with
`ENCRYPTION_KEY` and never shown again. The form says "Saved. Leave empty to
keep it." Enter a new value to replace one. What you type stays hidden; the
eye button at the end of the field shows it. Paste a multi-line key, such as
the JSON key of a Google service account, as a whole: the field keeps it on
one line, which JSON does not mind. When you change where a secret
is sent (the URL or server, the port, the encryption), enter the secret
again: a saved secret never follows to a new address. The audit log records
which settings changed, never their values. On the server, `cli settings
apply connections` takes secrets only in the JSON body on stdin, with the
same rules.

### Buttons on the connection page

| Button | What it does |
| --- | --- |
| Test connection | Signs in and reads a little data. Shows the result and stores it as the connection's status. |
| Import groups (or channels, teams) | Reads the app's groups into the catalog that access profiles and teams choose from. Groups the app no longer lists are marked "no longer listed" and stop counting as desired access. |
| Compare accounts now | Reads all accounts. Shown only when the app can list accounts. |
| Import people now | For people imports: runs the import at once. |

The worker also runs comparisons and imports on their own, every
"Compare accounts every (minutes)" or "Import people every (minutes)". 0 turns
the schedule off.

### What an account comparison does

A comparison reads accounts and changes nothing in the app. In this app it:

- stores each account's status (active, disabled, not found);
- links an unlinked account to a person when exactly one person has its email
  as work email or its username in the person's Username field, and that
  person has no other linked account there;
- marks accounts the app no longer lists as "not found";
- reports drift: active people without an active account, accounts that are
  active although the person has no access (including planned and offboarded
  people), and active accounts linked to nobody.

Fixing drift is a decision: start an access update or offboarding from the
person's page.

### Managed groups

The app adds and removes only managed groups: groups that some access profile
or team uses. Every other membership in the app stays as it is.

### Failures and retries

- Timeouts, rate limits and server errors (HTTP 429 and 5xx) retry
  automatically. The job runs up to 6 times, with pauses of 1, 2, 4, 8 and 16
  minutes.
- Refused credentials, missing permissions, invalid data and the last failed
  retry fail the job and open a task. Fix the cause and press **Retry** on the
  job, or make the change by hand and complete the task.
- Unexpected errors show only the error type. The details are in the worker
  log.

### Initial passwords

Google Workspace (option "Email a first password") and Keycloak (option "Set a
temporary password") can generate a first password for a new account. The app
emails it once to the person's personal email through the first email
connection that is turned on, then forgets it. If there is no email connection
or no personal email, or sending fails, a task asks someone to set a new
password and hand it over. The password is never stored.

## Keycloak

Creates, enables and disables users in one realm and manages their group
memberships, through the Keycloak Admin REST API.

This connection is separate from signing in to IAM, which uses its
own client (docs/authentication.md).

**Set up in Keycloak first**

1. In the realm, create a client with client authentication on and
   **service accounts** on (a confidential client). Standard flow is not
   needed.
2. Under the client's **Service account roles**, assign these roles of the
   `realm-management` client: view-users, query-users, manage-users,
   query-groups and view-realm.
3. Keycloak 26.8.2 and later: under the client's **Client scopes**, add
   `kc-admin-api` as a **Default** scope. The Admin REST API refuses tokens
   without the audience it adds (401).
4. For the setup email: configure the realm's email settings.

| Field | Required | Meaning |
| --- | --- | --- |
| Keycloak URL | yes | Without `/realms/...`. Include `/auth` only for Keycloak versions before 17. |
| Allow plain HTTP | no | Only for a Keycloak in the same private network, e.g. `http://keycloak:8080` in one Docker network. Otherwise the URL must use HTTPS (except localhost). |
| Realm | yes | The realm to manage. |
| Client ID | yes | The client from step 1. |
| Client secret | yes | Its secret. |
| Group root | no | Import only groups below this path, e.g. `/apps`. The root group itself is not imported. Empty imports every group. |
| Username | no | Login name (the work email before @, or the person's username) or the full work email. |
| Send setup email | no (on) | After creating a user, Keycloak emails a link to set a password. Needs a work email and the realm's email settings. |
| Setup link valid for (hours) | no (72) | Lifespan of that link. |
| Set a temporary password | no (off) | Instead of the setup email: a temporary password, emailed to the personal address (see Initial passwords). Keycloak asks for a new one at first sign-in. When both options are on, the setup email wins. |
| End sessions on disable | no (on) | Signs the user out of every session when the account is disabled. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. |

**Behavior**

- Finding an account: by stored ID, then exact username, then exact email.
  Several matches stop the job, and so does a user with that username whose
  email differs from the work email.
- If Keycloak already has the user (HTTP 409), the app links it and enables it
  again, unless its email differs from the work email.
- A failed setup email or temporary password only adds a note to the job; the
  user exists. The note says where to send the email by hand.
- Existing users keep their first and last name in sync. Username and email are
  never changed by the app; a differing email adds a note.
- Keycloak puts a new user in the realm's default groups. The app then
  removes the managed ones the person should not have, and a rehearsal reads
  the default groups to say so.
- Disabling removes the managed group memberships, turns the user off and, if
  set, ends its sessions.
- Account comparisons skip service-account users.

## Google Workspace

Creates, suspends and reactivates users and manages their Google Groups
memberships, through the Admin SDK Directory API.

**Set up in Google first**

1. In a Google Cloud project, enable the Admin SDK API, create a service
   account and download its JSON key.
2. Give the service account access in one of two ways:
   - **Admin roles (recommended):** in the Google Admin console, under
     Account > Admin roles, assign the roles **User Management Admin** and
     **Groups Admin** to the service account's email (Assign admin > Assign
     service accounts). The service account acts as itself, with only these
     roles; leave **Admin user** empty. Role changes can take a while to
     apply.
   - **Domain-wide delegation:** in the Google Admin console, give the
     service account's client ID domain-wide delegation for the scopes
     `admin.directory.user`, `admin.directory.group` and
     `admin.directory.group.member`, and choose an administrator for it to
     act as (**Admin user**).

| Field | Required | Meaning |
| --- | --- | --- |
| Service account key (JSON) | yes | The JSON key from step 1. |
| Admin user | no | Only for domain-wide delegation: the administrator the service account acts as. Empty: the service account acts as itself with its admin roles. |
| Domains | yes | The Workspace domains, separated by commas, the primary domain first. Work emails of new users must be in one of them; others stop the job. Comparisons read the accounts of all domains either way. Without an admin user, the app reads a person's groups only in these domains: choose groups from them. |
| Customer ID | no (`my_customer`) | Without an admin user, the app looks up the ID from a user of the first domain. Change only if the admin user manages several accounts, or to skip the lookup (Admin console > Account > Account settings). |
| Organizational unit for new users | no (`/`) | Where new users go, e.g. `/Staff`. |
| Email a first password | no (on) | New users get a generated password that must be changed at first sign-in, emailed to the personal address (see Initial passwords). Off: Google still requires a password, so the app sets a random one nobody knows; set a password in the Admin console or use single sign-on. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. |

**Behavior**

- New users get the personal email as recovery email.
- If the user already exists (HTTP 409), the app links it without setting a
  password and reactivates it if suspended.
- Disabling suspends the user and removes the managed Google Groups
  memberships.
- Super admins are never suspended automatically: the job fails and a task asks
  for a decision.
- Suspended accounts with administrator rights, or with unknown rights, are
  never reactivated automatically.
- Members are added to groups with the role MEMBER. An existing membership or a
  missing one on removal counts as done.

## SCIM 2.0 app

Creates, deactivates and groups accounts in any app with a SCIM 2.0 endpoint
(RFC 7643 and RFC 7644), for example Connector, which gets its users from
IAM this way.

**Set up in the app first:** turn on SCIM provisioning and create a bearer
token. Note the SCIM base URL that `/Users` and `/Groups` follow.

| Field | Required | Meaning |
| --- | --- | --- |
| SCIM base URL | yes | E.g. `https://app.example.invalid/scim/v2`. |
| Bearer token | yes | The app's SCIM token. |
| User name | no (work email) | What the app's `userName` holds: the work email or the username. |
| When access ends | no (deactivate) | Deactivate the user (`active = false`) or delete it. |
| Manage groups | no (on) | Turn off for apps without a `/Groups` endpoint. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. |

**Behavior**

- Test connection reads `/ServiceProviderConfig` and lists one user, which
  proves the token. It warns when the app reports no PATCH support, because
  deactivation and group changes need PATCH.
- Finding an account: by stored ID, then `userName eq`, then `emails.value eq`
  (skipped if the app does not support that filter). Several matches stop the
  job, and so does a user with that `userName` whose emails do not include the
  work email.
- If the user already exists (HTTP 409), the app links it and activates it,
  unless that user is someone else's by the rule above.
- Deactivation sends a PATCH on `active`; if the app refuses that form, the app
  retries with the value form. In delete mode it deletes the user.
- Group memberships change with PATCH on `/Groups/{id}`.

## HubSpot

Invites users, puts them in teams and removes them when access ends, through
HubSpot's Settings Users API. Groups are HubSpot **teams**.

**Set up in HubSpot first:** create a private app with the scopes
`settings.users.read`, `settings.users.write` and `settings.users.teams.read`,
and copy its access token.

| Field | Required | Meaning |
| --- | --- | --- |
| Private app access token | yes | The private app's token. |
| Role ID for new users | no | Empty: HubSpot's default access. The ID is in Settings > Users & Teams > Roles. |
| Send HubSpot's welcome email | no (on) | New users get HubSpot's invitation to set their password. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. |

**Behavior**

- HubSpot's API cannot deactivate users. **Disabling deletes the HubSpot user.**
  Records the user owns stay in HubSpot.
- A user that exists but is deactivated is not reactivated: the job fails and
  asks for reactivation in HubSpot.
- Seats and permission sets stay with HubSpot admins; the app never assigns
  them.
- The first team becomes the primary team; removing the primary team promotes
  the first secondary team.
- If the users API answers 404, no user is confirmed missing: the app assumes
  the API version may have changed and stops.
- Not tested yet against the live HubSpot API: team assignment.

## Slack

Tracks Slack members. Invitations, channel changes and deactivations always
become tasks, because Slack's member APIs need Enterprise Grid (or SCIM on
Business+). Groups are **channels**.

**Optional:** a bot token lets the app read members and channels. Create a
Slack app with the bot scopes `users:read`, `users:read.email`,
`channels:read` and `groups:read`, install it, and copy the `xoxb-` token.

| Field | Required | Meaning |
| --- | --- | --- |
| Bot token | no | Without it, changes are tasks, channels are added by hand and accounts are not compared. |
| Workspace URL | no | Linked in every task. |
| Invite as guests | no (`external`) | Person types invited as multi-channel guests, comma-separated. Everyone else is invited as a full member. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. Needs the bot token. |

**Behavior**

- Import channels lists public and private channels the token can see, without
  archived ones. Channels can also be added by hand.
- Channel membership is never read (that needs one call per channel), so drift
  covers accounts, not channels.
- Deactivated members count as disabled. Bots, app users and Slackbot are
  skipped.
- Without a token, completing a task records the change.

## Notion

Tracks Notion workspace members. Invitations and removals always become tasks:
Notion's public API cannot invite or remove members. No groups.

**Optional:** an internal integration token with the capability "Read user
information including email addresses" lets the app read members.

| Field | Required | Meaning |
| --- | --- | --- |
| Integration token | no | Without it, changes are tasks and accounts are not compared. |
| Workspace URL | no | Linked in every task. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. Needs the token. |

**Behavior**

- Only members of type "person" count; bots are skipped.
- Notion has no deactivated state and does not list removed members: every
  listed member is active, and a removed one shows as "not found".
- If Notion hides some members' email addresses, a lookup by email stops with
  an error instead of reporting the account as missing.

## Relution

Mobile device management. Creates SSO-only users, manages their group
memberships, and deactivates users on offboarding.

**Set up in Relution first:** create an API access token for a Relution user
that may only manage the organization's users and group memberships. Note the
organization UUID.

| Field | Required | Meaning |
| --- | --- | --- |
| Relution address | yes | The origin only, without a path or credentials. HTTPS, except localhost. |
| Organization UUID | yes | Users are created in this organization; others are ignored. |
| API access token | yes | The token. |
| Sign in only through single sign-on | no (on) | New users get no Relution password. |
| Use the work email as managed Apple ID | no (on) | Sets the managed Apple ID to the work email. |
| Compare accounts every (minutes) | no (360) | 0 turns it off. |

**Behavior**

- **The app never deletes Relution users**: deleting one also affects the
  devices enrolled for it. Retire devices separately.
- Disabling sets the user to not activated and **keeps its group
  memberships**, so group-based policies and apps stay on devices still in use.
  Access updates still add and remove managed groups.
- New users need a work email. The app never creates groups and never sets a
  password.
- Lookups page through all users of the organization, by work email, then by
  login name. Several matches stop the job, and so does a user found by login
  name whose email differs from the work email.
- A locked user counts as not active. The app does not reactivate it: the
  job fails and nothing is changed until someone unlocks it in Relution.
  Disabling deactivates a locked user that is still activated, so unlocking
  it later does not let the person in.
- After every change the app reads the user or its memberships again and fails
  the job if Relution does not confirm the change.

## Other app (manual tasks)

For any app without an API. Every account or group change becomes a task with
the steps below; completing the task records the change. Groups are added by
hand on the connection page.

| Field | Required | Meaning |
| --- | --- | --- |
| App name | yes | Shown in tasks. |
| Admin page | no | Linked in every task. |
| Instructions | no | Added to every task, e.g. which license to assign. |

## Personio

Imports people from Personio: names, emails, job title, type, team, manager,
start and end dates. Read only: nothing is written to Personio. Uses the
Personio API v1.

**Set up in Personio first:** create API credentials in Settings >
Integrations > API credentials.

| Field | Required | Meaning |
| --- | --- | --- |
| Client ID | yes | From the API credentials. |
| Client secret | yes | From the API credentials. |
| API URL | no (`https://api.personio.de`) | Change only for a different Personio API host. |
| Work email domains | no | Comma-separated. A Personio email outside these domains becomes the personal email. Empty: Personio's email is the work email. |
| Person types | no | One line per value: `Personio value = employee`, `intern`, `freelancer`, `volunteer` or `external`. |
| Team attribute | no (`department`) | The Personio attribute whose value names the team. |
| List leavers for (days) | no (30) | People who left longer ago are no longer imported. |
| Import people every (minutes) | no (60) | 0 imports only when started by hand. |

**Mapping**

- Person type: a configured line for the employment type wins, then one for the
  position. Without a match: `internal` becomes employee, `external` becomes
  external, anything else becomes employee.
- Team: matched by name (case-insensitive) to a team in this app. A name with
  no matching team leaves the person's team as it is.
- Manager: the supervisor's email, or the work email of the supervisor's
  Personio record. Matched to a person by work email.
- Private email, planned start date and supervisor custom attributes are found
  by their label.
- End date: the termination date wins over the contract end date. The "last
  day at work" attribute is ignored.
- A person is inactive when the status is inactive, terminated or
  terminated_with_access, or the end date has passed.

**What the import does in this app**

- New active people are added as planned, with the access profile that is the
  default for their type. Inactive or already-left records are not added.
- A record is matched by its Personio ID, or else to a person without a source
  that has the same work email. That person is then linked to Personio.
- Names, personal email, job title, type, start and end dates, team and manager
  are updated. A work email is filled in only when the person has none; a
  differing work email is reported, never changed.
- The import never offboards anyone. The schedule starts offboarding the day
  after a person's end date. People missing from Personio, and inactive people
  without an end date, are reported in the import summary.
- Records with a missing ID or name, or an unreadable date, are skipped; the
  rest still import.

## Email (SMTP)

Sends notifications about new manual tasks and identity requests, and the
initial passwords of new accounts, through any SMTP server or sending service. The app uses the first
email connection that is turned on. Notification recipients are set in
**Admin > Settings**.

| Field | Required | Meaning |
| --- | --- | --- |
| SMTP server | yes | Host name. |
| Port | no (587) | |
| Encryption | no (STARTTLS) | STARTTLS (usually port 587), TLS from the start (usually port 465), or none (only inside a trusted network). |
| Username | no | Sign-in is skipped when empty. |
| Password | no | |
| From address | yes | The sender; the server must be allowed to send for it. |
| From name | no | E.g. "IT team". |
| Reply-to address | no | |

**Behavior**

- Test connection connects, signs in if a username is set, and checks the
  server; it sends nothing.
- A line break in the subject or an address stops the email before sending.
- Refused credentials or encryption problems are configuration errors.
  Timeouts, lost connections and 4xx answers are temporary.

## Writing a new adapter

1. Create a module in `apps/server/src/adapters/` with a subclass of `Adapter`
   (`base.ts`). Set the static `slug`, `label`, `description`, `kind`
   (`AdapterKind.PROVISIONING`, `HR_SOURCE` or `EMAIL`) and `fields` (built
   with `field()`). Field kinds: text, url, email, int, bool, choice,
   textarea, secret. Field names are the keys stored in the database.
   Add `SYNC_INTERVAL_FIELD` for account comparisons.
2. Declare what the app can do: `supportsWrite`, `supportsGroups`,
   `supportsAccountListing`, `manualGroups`, `removeGroupsOnDisable`,
   `groupLabel`. An adapter that can read only with optional credentials
   overrides `canReadAccounts()`.
3. Implement `testConnection()` and, for accounts and groups, the primitives
   `findAccount`, `createAccount`, `setActive`, `accountGroups`,
   `addToGroup`, `removeFromGroup`, `listGroups`, `listAccounts` and
   `manualInstructions`. The base class combines them into `ensureAccount`
   and `disableAccount`; both must be safe to run again. A people import
   implements `listPeople()`, an email adapter `sendMessage()`.
   `findAccount` returns only an account that is the person's: after a match
   by username, call `checkSameEmail`, which stops at a user whose email is
   not the person's work email.
4. Make HTTP calls with `this.http()` and `this.call()`. They map timeouts,
   429 and 5xx to `TransientError` (the job retries) and 401/403 to
   `ConfigurationError`; other errors are `AdapterError` (the job fails and
   opens a task).
5. Never put tokens, passwords or provider response bodies in error messages or
   results. Adapters never touch the database: they get the configuration as an
   object and return plain data.
6. Register the adapter in `apps/server/src/adapters/registry.ts`.
7. Test it without network: pass `{ fetch: mockFetch(handler) }` from
   `apps/server/src/test/mock-fetch.ts` as the adapter's options. See the
   `*.test.ts` files next to the adapters for examples.
