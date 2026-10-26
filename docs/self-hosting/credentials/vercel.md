# Vercel token and webhook for Afe

Afe reads Vercel deployments through the REST API with an access token, and can
receive deployment webhooks.

References: [Access tokens](https://vercel.com/docs/rest-api#creating-an-access-token),
[Webhooks](https://vercel.com/docs/webhooks), [Team roles](https://vercel.com/docs/rbac/access-roles).

> How the token, team id and webhook secret are entered into Afe, and the final
> list of webhook events, are **to be finalised when AFE-11 (Vercel connector)
> lands**.

## Read-only is not available: least privilege instead

Vercel tokens cannot be restricted to read-only. This is a documented exception
in [security rules R1](../../security/rules.md#r1--least-privilege-read-only-everywhere);
Afe compensates by only ever issuing `GET` requests (enforced by a test), and you
limit what a leaked token could do:

- **Scope** the token to the single team Afe should observe.
- **Expiry**: always set one (e.g. 90 days) and rotate before it expires.
- **Role**: create the token as a team member with the least-privileged role your
  plan offers (e.g. **Viewer** on Pro/Enterprise). A token acts with its
  creator's role, so a dedicated member account with that role is best.

## 1. Create the token

1. Sign in as the (ideally dedicated, low-privilege) member.
2. **Account Settings → Tokens** (`https://vercel.com/account/tokens`).
3. Name: `afe`; Scope: your team; Expiration: e.g. 90 days. **Create**.
4. Copy the token straight into Afe (step 3). It is shown only once.

Note the **team id** (Team Settings → General → Team ID, `team_...`).

## 2. Create the webhook (optional, recommended)

Webhooks are configured per team: **Team Settings → Webhooks** (available on
paid plans; without it, Afe relies on polling).

| Field    | Value                                                                     |
| -------- | ------------------------------------------------------------------------- |
| URL      | `https://<public-host>/webhooks/vercel`                                   |
| Events   | Deployment Created, Succeeded, Error, Canceled, Promoted (pending AFE-11) |
| Projects | All, or the projects to observe                                           |

Vercel shows the webhook **secret** once after creation; Afe needs it to verify
the `x-vercel-signature` header on every delivery. If you cannot expose an
endpoint, see [webhooks behind a firewall](../webhooks-behind-firewall.md).

## 3. Give the token, team id and webhook secret to Afe

Stored encrypted in Afe's database, never in `.env`.

> **To be finalised when AFE-11 lands.**

## Rotating and revoking

- **Token**: create a new token, enter it into Afe, then delete the old one in
  Account Settings → Tokens. Do this before the expiry date; an expired token
  makes the connection unhealthy and opens an observation gap until replaced.
- **Webhook secret**: Vercel does not rotate a webhook's secret in place; create
  a new webhook, enter its secret into Afe, then delete the old webhook.
- **Revoke**: delete the token (and webhook). Afe marks the connection revoked.
