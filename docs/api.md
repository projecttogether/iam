# API for other apps: identity requests

Other apps ask for new people through this API: Helpdesk, a script, an
HR tool. Each request waits in **Requests** until an approver
adds the person, links a person who is already here, or rejects it. The
sending app reads the outcome back.

The API can do nothing else. It cannot read people, change access or start
workflows.

## Set up

1. **Admin › Settings › Identity requests:** choose the person types other
   apps may request (employee, intern, freelancer, volunteer, external).
   With none chosen, the app accepts no requests.
2. **Admin › API keys:** create a key per app, named after it. The key is
   shown once; store it in the other app. On the server,
   `docker compose exec -T web cli tokens create api-key --name Helpdesk`
   creates one and prints only the key
   ([deployment.md](deployment.md#api-keys)). IAM keeps its SHA-256 and its
   first characters, to tell keys apart. Revoke a key that leaked or is no
   longer used; create a new one instead. Every key may read and cancel every
   request, so a new key takes over from the one it replaces.
3. Optional: **Admin › Settings › Notification emails** get an email for each
   new request (through the email connection).

## Requests

Base URL: `<APP_URL>/api/integration/v1`. Send the key as a bearer token:

```http
GET /api/integration/v1/identity-requests/options HTTP/1.1
Host: iam.example.invalid
Authorization: Bearer iam_…
```

Bodies and answers are JSON. Dates are `YYYY-MM-DD`, times ISO 8601. Errors
have the form `{ "error": { "code", "message", "fields"? } }`; `fields`
names the fields to fix, with a message each.

| Status | Meaning |
| --- | --- |
| `401` | No key, or the key is unknown or revoked. |
| `403` `identity_requests_off` | The installation accepts no identity requests (Admin › Settings). |
| `404` | No request with this ID. |
| `409` `request_closed` | The request was decided already, so it cannot be cancelled. |
| `409` `reference_reused` | The reference was already used for a request with other details. |
| `422` `validation_error` | Fix the named fields, e.g. a person type this installation does not accept. |

### `GET /identity-requests/options`

The choices for a request form.

```json
{
  "personTypes": [{ "value": "employee", "label": "Employee" }],
  "teams": [{ "id": 3, "name": "Research" }]
}
```

`personTypes` lists only the types chosen in Admin › Settings. An empty
list means the app accepts no requests.

### `POST /identity-requests`

| Field | Required | Meaning |
| --- | --- | --- |
| `externalId` | yes | The sender's reference, at most 255 characters. References are shared by every key, so start them with the app, e.g. `helpdesk:<ID>`. One request per reference: the same details again answer with the request stored first (`200` instead of `201`); other details under the same reference are refused (`409 reference_reused`). Send changes as a new request. |
| `externalUrl` | no | An http(s) link to the sender's record, shown to approvers. |
| `requestedBy` | no | `{ "name", "email" }` of whoever asked, as the sender knows them. IAM does not check it. |
| `firstName`, `lastName` | yes | |
| `personType` | yes | `employee`, `intern`, `freelancer`, `volunteer` or `external`; only the types the installation accepts. |
| `personalEmail` | no | Receives the initial password of new accounts once the person is added; the approver checks it. |
| `jobTitle` | no | |
| `teamId` | no | A team from the options. |
| `managerEmail` | no | The manager's work email; the approval form picks that person. |
| `startDate`, `endDate` | no | The end date is the last working day. |
| `notes` | no | At most 5000 characters, e.g. what the person needs. |

The answer is the request (below), `201` when it is new.

### `GET /identity-requests/{id}`

```json
{
  "id": 12,
  "externalId": "helpdesk:42",
  "status": "approved",
  "createdAt": "2026-11-23T09:00:00.000Z",
  "decidedAt": "2026-11-23T10:00:00.000Z",
  "reason": "",
  "url": "https://iam.example.invalid/requests/12",
  "person": { "status": "planned", "workEmail": "grace@example.invalid", "startDate": "2027-01-04" }
}
```

- `status`: `open`, `approved` (the person was added or linked), `rejected`
  (`reason` says why) or `cancelled`.
- `person`: once approved, the person's status in IAM (`planned`,
  `onboarding`, `active`, …), work email and start date. `active` means
  onboarding is done.
- `url`: the request in IAM, for people who can sign in there.

### `POST /identity-requests/{id}/cancel`

Withdraws an open request, for example when the contract fell through.
Cancelling a cancelled request is fine; a decided request answers `409`. A
person who was already added stays; ask the approvers to change or offboard
them.

## What approvers see

**Requests** lists the open requests; the sidebar counts them. A request
shows what was asked, who asked, through which key, people who may be the
same person (same personal or work email, or same name), and other open or
approved requests that may be for the same person (same personal email, or
same name and start date), e.g. sent from two tickets. An approver:

- **adds the person:** the person form opens prefilled from the request;
  the approver completes it (e.g. the work email) and saves. The request is
  approved in the same step. Onboarding follows as for anyone added by hand.
- **links a person** who is already here, e.g. one Personio imported or
  someone who returns: one of the suggestions, or anyone else. Nothing
  changes in the person's record.
- **rejects** the request with a reason the sender shows the people who asked.

Every step is in the audit log; the key's actions under `API key "<name>"`.
