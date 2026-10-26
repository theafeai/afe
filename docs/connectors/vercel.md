# Connecting Vercel

Afe reads deployments of the Vercel projects you choose. It never changes
anything in Vercel. For the reasoning behind this design, see
[ADR 0005](../decisions/0005-vercel-connection-model.md).

## Option A: Vercel Integration (recommended)

The integration asks only for read permissions, and Afe stores a token that you
never handle yourself.

### Self-hosters: create the integration once

1. In Vercel, open Integrations Console > Create.
2. Set the **Redirect URL** to `<AFE_PUBLIC_URL>/api/connections/vercel/callback`.
3. Set the **Webhook URL** to `<AFE_PUBLIC_URL>/webhooks/vercel` and select the
   deployment events (`deployment.created`, `deployment.succeeded`,
   `deployment.error`, `deployment.canceled`, `deployment.promoted`) and
   `project.removed`.
4. Under **Permissions**, grant **Read** on User, Team, Projects and
   Deployments, and nothing else.
5. Configure Afe with the integration's values:

   | Variable                                                      | Value                                                          |
   | ------------------------------------------------------------- | -------------------------------------------------------------- |
   | `AFE_PUBLIC_URL`                                              | Public base URL of Afe, e.g. `https://afe.example.com`         |
   | `AFE_VERCEL_CLIENT_ID`                                        | Integration client id (`oac_…`)                                |
   | `AFE_VERCEL_CLIENT_SECRET` or `AFE_VERCEL_CLIENT_SECRET_FILE` | Client secret. It also verifies webhooks and signs OAuth state |
   | `AFE_VERCEL_INTEGRATION_SLUG`                                 | The slug in `https://vercel.com/integrations/<slug>`           |

   The three `AFE_VERCEL_*` values must be set together.

### Connect

1. Open `GET /api/connections/vercel/install`. Afe redirects you to Vercel.
2. In Vercel, choose the team (or personal account). Optionally limit the
   integration to specific projects there as well.
3. Vercel sends you back to Afe, which stores the token encrypted and creates
   the connection. Its id is the team id, or your user id for a personal
   account.
4. Choose the projects to observe (see below). Until you do, Afe observes nothing.

You must start the installation from Afe. An installation started from the
Vercel marketplace is rejected, because it has no signed `state`.

## Option B: Access token (fallback)

> **Warning:** Vercel access tokens cannot be limited to read-only. A token has
> full access to everything in its scope, with the role of the person who
> created it. Afe only sends `GET` requests with it, but anyone who obtains the
> token can do much more.

1. In Vercel, open Account Settings > Tokens > Create. Set **Scope** to the one
   team to connect and set an **expiry**. Create the token as a team member
   with the least-privileged role your plan offers (e.g. Viewer).
2. `POST /api/connections/vercel` with `{"token": "…", "teamId": "team_…"}`.
   Omit `teamId` for a personal account.
3. Optional webhooks (Pro/Enterprise): create a webhook in Team Settings >
   Webhooks for the deployment events, with the URL
   `<AFE_PUBLIC_URL>/webhooks/vercel/<team id>`. Then add its secret by
   reconnecting with `{"token": "…", "teamId": "…", "webhookSecret": "…"}`.
   Without webhooks, Afe relies on polling (AFE-12).

To rotate the token, `POST` again with the new token. The old credential is
destroyed.

## Choosing projects

- `GET /api/connections/vercel/:id/projects` lists the projects the connection
  can see and shows which ones are selected.
- `PUT /api/connections/vercel/:id/projects` takes `{"projectIds": ["prj_…"]}`,
  or `{"projectIds": []}` for none, or `{"projects": "all"}`. Unknown project
  ids are rejected.

Afe never requests deployments of unselected projects, and webhook events for
them are dropped.

## Disconnecting and revocation

- `DELETE /api/connections/vercel/:id` destroys Afe's stored token and marks
  the connection `disconnected`.
  - For integrations, Afe also asks Vercel to remove its installation. If that
    fails, the response says so; remove "Afe" in Team Settings > Integrations.
  - For tokens, delete the token in Vercel as well.
- If you uninstall the integration in Vercel, Vercel sends
  `integration-configuration.removed`. Afe then destroys the token and marks the
  connection `revoked`.
- If Vercel answers any call with 401 or 403 (token revoked or expired, access
  to the team lost), the connection becomes `revoked`, with the reason shown.
  Reconnect to resume.

## Permissions requested and why

| Permission  | Access | Used for                                                               |
| ----------- | ------ | ---------------------------------------------------------------------- |
| User        | Read   | `GET /v2/user`: identify the account (personal accounts, actor ids)    |
| Team        | Read   | `GET /v2/teams/{id}`: team name and health check                       |
| Projects    | Read   | `GET /v9/projects`: project selection; mapping deployments to projects |
| Deployments | Read   | `GET /v6/deployments`, `GET /v13/deployments/{id}`: the audited data   |

Afe uses only two non-GET calls, both to manage its own access:

- the OAuth code exchange, `POST /v2/oauth/access_token`;
- removing its own installation on disconnect, `DELETE /v1/integrations/configuration/{id}`.

Afe never stores environment-variable values. `env` and `build.env` fields are
stripped from every API response and webhook payload.
