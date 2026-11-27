# Glossary

The domain language of IAM. [docs/architecture.md](docs/architecture.md)
explains how the pieces work together.

- **Person**: someone whose access the app manages. Has a type (employee,
  intern, freelancer, volunteer, external), a status (planned, onboarding,
  active, offboarding, offboarded, archived), a team, an access profile, a
  start date and an end date.
- **End date**: the schedule starts a person's offboarding the day after it.
  An import from Personio sets it to the last day at work, else the
  termination date, else the contract end, and keeps those three dates under
  Personio's names for the person page.
- **App user**: someone who may use this app, with a role (viewer, approver,
  admin). May be linked to a person; offboarding that person turns the app
  user off.
- **Identity request**: another app's request to add a person (open,
  approved, rejected, cancelled). An approver adds the person from it, links
  a person already here, or rejects it. Only the person types chosen in
  Admin › Settings can be requested.
- **API key**: what another app sends identity requests with. Shown once;
  the app keeps its hash. It reaches only the API for identity requests.
- **Connection**: one connected app or service, configured in Admin ›
  Connections: an adapter type, settings, encrypted secrets, a mode
  (automatic, manual, read only) and an on/off switch.
- **Adapter**: the code for one kind of connection (`apps/server/src/adapters/`). Three
  kinds: accounts and groups (provisioning), people import (HR source),
  email.
- **Group**: something access can grant inside a connected app: a Keycloak
  group, a Google Group, a HubSpot team, a Slack channel. Imported into the
  group catalog, or added by hand for apps without a group API.
- **Access profile**: the accounts, with groups, a kind of person gets. One
  profile can be the default for each person type.
- **Team**: a group of people; its groups apply at every connection where the
  member's profile grants an account.
- **Desired access**: what profile and team grant, for people whose status
  allows access; nothing for everyone else.
- **Managed group**: a group any profile or team uses. The app adds and
  removes only managed groups.
- **Account**: an account in a connected app, linked to a person or not, with
  the status and groups the app last saw. Linked to at most one person;
  never changed for anyone else.
- **Applied groups**: the groups this app put an account in. They stay
  removable from that account after a profile or team stops using them.
- **Workflow**: onboarding, access update or offboarding of one person. It
  keeps the desired-access snapshot it was started with.
- **Job**: one change at one connection: create or update an account, or
  disable it. Run by the worker, retried on passing errors.
- **Task**: work for a person: a change in an app without automation, a failed
  job, groups a job could not update, or sign-in details to hand over.
- **Held removal**: an automatic removal over the daily removal limit; it
  waits for an admin's approval.
- **Read-only mode**: a deployment setting (`READ_ONLY=1`). The app reads
  connected apps, changes nothing in them, sends no email and rehearses
  every job. Not the same as a read-only connection, whose changes become
  manual tasks.
- **Rehearsal**: a job run in read-only mode. It reads the account and its
  groups and records what the job would change, without changing it. The
  job and its rehearsal follow the same plan, so where the job would fail,
  the rehearsal fails too.
- **Sync run**: a read from a connection: group import, account comparison
  or people import. Never changes the connected app.
- **Drift**: differences an account comparison finds between desired access
  and the accounts it saw.
- **Audit event**: an append-only record of a change, without secret values.
