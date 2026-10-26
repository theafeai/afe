# GitHub App for Afe

Afe reads GitHub through a GitHub App that **you** create and own, so no
credential ever leaves your infrastructure. The app is read-only.

References: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[Installing your own app](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

> The exact permission and event list, and how the app's credentials are entered
> into Afe (manual form, CLI, or a manifest flow that creates the app in one
> click), are **to be finalised when AFE-6 (GitHub App connector) lands**. The
> steps below are the manual path, which will keep working.

## 1. Create the app (manual)

Own the app by the organization you will monitor (for a test, your test org):
**Organization → Settings → Developer settings → GitHub Apps → New GitHub App**
(`https://github.com/organizations/<org>/settings/apps/new`).

| Field                     | Value                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GitHub App name           | e.g. `afe-<your-org>` (must be globally unique)                                                                            |
| Homepage URL              | your Afe URL, or `https://github.com/theafeai/afe`                                                                         |
| Callback URL / Setup URL  | leave empty (pending AFE-6)                                                                                                |
| Webhook: Active           | checked (uncheck if you will run [polling only](../webhooks-behind-firewall.md#option-3-no-inbound-webhooks-polling-only)) |
| Webhook URL               | `https://<public-host>/webhooks/github`                                                                                    |
| Webhook secret            | output of `openssl rand -hex 32`; keep it for step 3                                                                       |
| SSL verification          | **Enabled** (never disable it)                                                                                             |
| Where can it be installed | **Only on this account**                                                                                                   |

### Repository permissions (all read-only)

Set every other permission to **No access**.

| Permission   | Access    | Why                                       |
| ------------ | --------- | ----------------------------------------- |
| Metadata     | Read-only | Mandatory; repository names and ids       |
| Deployments  | Read-only | Deployments and deployment statuses       |
| Actions      | Read-only | Workflow runs and jobs that deploy        |
| Environments | Read-only | Environment names and protection settings |

This is the baseline in [security rules R1](../../security/rules.md#r1--least-privilege-read-only-everywhere).
Afe does not need `Contents`, `Secrets`, `Variables` or any write permission. If
AFE-6 adds a permission, it will be listed here with its justification.

### Subscribe to events

Tick only: **Deployment**, **Deployment status**, **Workflow run**.
(Final list to be confirmed by AFE-6. GitHub only offers the events your
permissions allow.)

Click **Create GitHub App**.

## 2. Generate a private key

On the app's page, note the **App ID**. Under **Private keys**, click
**Generate a private key**; a `.pem` file downloads. Treat it like a password:
it authenticates as the app. Keep it only until you have entered it into Afe,
then delete the downloaded copy.

## 3. Give the credentials to Afe

Afe needs the App ID, the private key and the webhook secret. They are stored
encrypted in Afe's database (never in `.env`), and can be rotated later.

> **To be finalised when AFE-6 lands** (UI form, API call or `afe` CLI command).

## 4. Install the app on your organization

App page → **Install App** → choose the organization → **All repositories** or
**Only select repositories** → **Install**. Afe discovers the installation
(via the `installation` webhook or on its next poll) and starts observing.

For a quick end-to-end check, run a workflow in one of the selected
repositories and look at **Advanced → Recent Deliveries** on the app page:
deliveries should get `202`/`200` responses.

## Rotating and revoking

- **Private key**: generate a new key on the app page, enter it into Afe, then
  delete the old key on GitHub. GitHub allows several active keys, so there is
  no downtime.
- **Webhook secret**: generate a new secret, enter it into Afe, then update it
  on the app page. Deliveries signed with the old secret in between fail
  verification and are recovered by reconciliation.
- **Revoke**: uninstall the app (Organization → Settings → GitHub Apps) or
  delete it. Afe marks the connection revoked and records an observation gap.

## GitHub Enterprise Server

Same steps on your GHES instance (`https://<ghes>/organizations/<org>/settings/apps/new`).
If it is on a private network, set `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true` and,
for a private CA, mount the CA bundle and set `NODE_EXTRA_CA_CERTS`. Connection
settings for the GHES URL are **to be finalised when AFE-6 lands**.
