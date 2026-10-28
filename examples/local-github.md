# Run Afe locally and connect the GitHub Pages demo

Use these steps on macOS/Linux, or inside WSL2 on Windows. You need Git,
Python 3, OpenSSL and Docker with Compose; start Docker Desktop first if you
use it. This runs Afe and PostgreSQL on your computer. Pages runs on GitHub.

This is a dedicated disposable stack. The helpers refuse to overwrite an
existing `.env`, secrets directory or GitHub App configuration. Keep this
checkout while using the stack: its secrets and database volume are needed
across restarts.

## 1. Start Afe

In your computer's terminal, choose a new directory:

```sh
git clone --branch codex/afe-35-examples https://github.com/theafeai/afe.git afe-local-demo
cd afe-local-demo
sh examples/start-local-afe.sh
```

The first image build takes a few minutes. Open <http://localhost:8080>.
Read the login token locally:

```sh
cat secrets/afe_admin_token
```

Paste it into Afe's login screen. Do not send it in chat or commit it.

## 2. Create your private read-only GitHub App

Open <https://github.com/organizations/theafeai/settings/apps/new>. An owner
of `theafeai` must complete this screen.

| Field                                   | Value                                                           |
| --------------------------------------- | --------------------------------------------------------------- |
| GitHub App name                         | A unique name such as `afe-theafeai-demo-2026`                  |
| Homepage URL                            | `https://github.com/theafeai/afe`                               |
| Callback URL                            | Leave empty; this self-hosted test does not use installer OAuth |
| Setup URL                               | `http://localhost:8080/api/connections/github/setup`            |
| Redirect on update                      | Enable                                                          |
| Webhook Active                          | **Uncheck** for this polling-only test                          |
| Where can this GitHub App be installed? | Only on this account                                            |

Under **Repository permissions**, set **Actions**, **Deployments** and
**Environments** to **Read-only**. **Metadata** is automatically read-only.
Leave other permissions at No access. No write permissions are needed.
With webhooks inactive, no event subscriptions or public tunnel are required.

Click **Create GitHub App**. Note the numeric **App ID** (not Client ID).
Find the App slug in its public link `https://github.com/apps/APP-SLUG`.
Click **Generate a private key** and retain the downloaded `.pem` locally.

## 3. Configure Afe with that App

From the same `afe-local-demo` directory:

```sh
sh examples/configure-local-github.sh APP-ID APP-SLUG /absolute/path/to/downloaded.pem
```

Replace the three values. The helper copies the key under gitignored
`secrets/`, mounts it into server and worker, generates a separate local
webhook secret required by Afe's configuration, and restarts the services.
The webhook secret is unused while GitHub webhooks are inactive. The private
key contents never go into `.env` or command arguments. Once the copy is
confirmed, remove the extra downloaded key using your normal file manager.

## 4. Install and connect

1. Sign into Afe at <http://localhost:8080>.
2. Open **Connections → GitHub → Install on GitHub**. GitHub opens the App's
   installation screen.
3. Choose `theafeai`, then **Only select repositories → afe-demo → Install**.
4. GitHub returns your browser to local Afe's setup URL. Afe verifies the
   installation with the App and creates the connection. The local server
   must still be running, and the browser must be on the same computer.
5. In **Connections**, confirm the GitHub connection is active. Give the
   initial history backfill and polling several minutes to complete.

If you installed the App from GitHub before opening Afe, sign into Afe and
open its GitHub installation flow again. Alternatively, take the numeric ID
from GitHub's installation settings URL and open
`http://localhost:8080/api/connections/github/setup?installation_id=INSTALLATION-ID`
in that signed-in browser. This adoption path is for this single-tenant
self-hosted instance only; Afe still verifies the App's installation through
GitHub's API.

## 5. Observe the sample

Open <https://theafeai.github.io/afe-demo/> and inspect the current version.
In Afe open **Events**, filter source **GitHub** and repository
`theafeai/afe-demo`. Look for `workflow_run.completed` and successful
`deployment.status_updated` events in `github-pages`, with the same commit
as the [Pages workflow](https://github.com/theafeai/afe-demo/actions).
Earlier completed deployments can arrive through initial history backfill;
record that observation method rather than claiming live webhook delivery.

Use the [GitHub guide](github-actions.md) for the Version 2 change and
evidence checks. The verifier accepts `AFE_DEMO_URL=http://localhost:8080`
for local execution. Load the token privately into the verifier process:

```sh
AFE_DEMO_URL=http://localhost:8080 \
AFE_ADMIN_TOKEN="$(cat secrets/afe_admin_token)" \
python3 examples/ci/github-afe.py --repository theafeai/afe-demo \
  --connection-id CONNECTION-ID --run-ids VERSION-1-RUN-ID VERSION-2-RUN-ID
```

GitHub-hosted runners cannot reach your loopback instance. Run this command
locally; do not put your local admin token into repository secrets for this
setup. Browser recording requires a local Node/Playwright installation and
`AFE_CAPTURE_SCRIPT` pointing to `github-capture.mjs` alongside its Playwright
dependency; API verification works without it.

## Stop or restart

After configuring the App, always include the override with its secret mounts:

```sh
docker compose -p afe-demo-local -f docker-compose.yml -f examples/local-github-compose.yml stop
docker compose -p afe-demo-local -f docker-compose.yml -f examples/local-github-compose.yml up -d
```

Stopping retains the database. When finished, disconnect the demo in Afe,
uninstall the dedicated App, and use `down` with the same Compose arguments.
Only add `-v` if you intend to delete this test database. Remove local secret
files after the stack and App have been retired.
