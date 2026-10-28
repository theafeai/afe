# Try Afe with a tiny real application

These examples use one static page with a visible version. No application code,
package installation or build command is needed. Start with one tool, then reuse
the same repository for the others.

| Tool                                | Where the real deployment runs | Accounts / prerequisites                                      | Afe observation                                     |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------- |
| [GitHub Actions](github-actions.md) | Hosted GitHub Pages            | GitHub repository, Pages enabled, Afe GitHub App              | Workflow runs/jobs and deployment statuses          |
| [ArgoCD](argocd.md)                 | Local kind cluster             | Docker, kind, kubectl, ArgoCD CLI, public demo Git repository | Syncs, app changes and live revisions               |
| [Vercel](vercel.md)                 | Hosted Vercel project          | Vercel account and Git repository                             | Preview/production deployments                      |
| [Terraform](terraform.md)           | Local Docker                   | Terraform, Docker and the metadata reporter                   | Signed runner-reported plan/apply/destroy lifecycle |

GitHub and Vercel are real hosted services; local preview is not a substitute for
their events. Check their current plan limits before enabling paid features.
The local examples require downloads and enough memory for Docker/Kubernetes;
they do not provision paid cloud infrastructure.

## 1. Copy a standalone demo

From the Afe checkout, choose a new destination whose parent already exists:

```sh
sh examples/create-demo.sh ../afe-demo
cd ../afe-demo
python3 -m http.server 8090 --bind 127.0.0.1 --directory site
```

Visit <http://127.0.0.1:8090/>: **Version 1**. Stop with Ctrl+C. The copy helper
refuses an existing destination and includes the hidden GitHub workflow.
The standalone directory has no Afe workspace dependency.

For GitHub, ArgoCD or Vercel, create an **empty public test repository** called
`afe-demo` in your GitHub account/test organization, then publish the copy:

```sh
git init -b main
git add .
git commit -s -m "Add Afe demo application"
git remote add origin https://github.com/YOUR-ACCOUNT/afe-demo.git
git push -u origin main
```

Replace `YOUR-ACCOUNT`. Use your normal Git authentication. The initial Pages
workflow may fail until Pages is enabled; rerun it after the GitHub guide setup.
Private repositories require extra ArgoCD Git credentials and may require a
paid Pages plan; a disposable public repo avoids that setup. Do not put secrets
in the page, repository, Terraform configuration or state committed to Git.

## 2. Start or reuse Afe

If Afe is already running, skip this section. Otherwise, in a **fresh Afe
checkout** (not the demo directory), build from source; no published release is
required:

```sh
docker build -t afe:demo .
mkdir -p secrets
chmod 700 secrets
openssl rand -base64 32 > secrets/afe_encryption_key
openssl rand -hex 32 > secrets/afe_admin_token
chmod 644 secrets/afe_encryption_key secrets/afe_admin_token
cp .env.example .env
```

Use a fresh checkout to avoid overwriting an existing `.env` or encryption key.
Set `POSTGRES_PASSWORD` in `.env` to a random value from
`openssl rand -hex 24`, set `AFE_IMAGE=afe` and `AFE_VERSION=demo`, then:

```sh
docker compose up -d
docker compose up -d --wait --wait-timeout 180 afe-server
curl -fsS http://127.0.0.1:8080/healthz
```

Open <http://127.0.0.1:8080/>, sign in using the token in
`secrets/afe_admin_token`, and open **Connections**. Keep the token private.
Both server and worker must be running (`docker compose ps`). The worker has
no HTTP healthcheck; wait for the server only.

For GitHub App creation/OAuth redirects and inbound webhooks, configure
`AFE_PUBLIC_URL` in `.env` to an HTTPS URL reachable by your browser and provider,
then recreate the Afe services. Follow the
[networking guide](../docs/self-hosting/webhooks-behind-firewall.md). A local
loopback URL is not reachable by GitHub or Vercel. Token-based Vercel polling
does not require inbound webhooks.

## 3. Connect, deploy, change and verify

Follow a tool guide above. Each includes connection instructions, a Version 2
change, expected Afe observations and cleanup. **Connect before deploying** so
you can observe both runs. Polling may take several minutes; check the
connection's last-observed time rather than assuming a missing webhook means
failure. A static Python or Docker preview by itself produces no Afe events.

In Afe, start with the **Timeline**, filter by source/repository/project and
recent time. **Connections** should show an active connection and a recent
successful observation. Under **Mapping**, map the demo's source targets to a
service named `afe-demo` and the desired environments. The environment matrix
is based on observed deployment evidence; a workflow-only run does not prove
that the application is live. Journeys link events only when shared commit or
artifact identifiers exist. Do not expect every tool to produce every stage.

## Validation record

Keep a short record for each real run: tool/version, demo repository/commit,
connection id (no tokens), source run/deployment id, event ids visible in Afe,
expected versus actual version, observation method and cleanup result. This
supports [AFE-23](https://linear.app/theafe/issue/AFE-23).

The sample files and local checks can be validated without hosted credentials.
A hosted account connection/deployment must be recorded separately; this guide
does not claim that creating the files validates your GitHub or Vercel account.

## Stop and clean up

Use each guide's cleanup first, especially `terraform destroy` **before**
removing its state. Stop local preview/port-forward processes with Ctrl+C.
Disconnect test connections in Afe; revoke source tokens/uninstall test Apps,
then remove hosted demo projects/repositories if no longer needed.

For the dedicated Afe test stack, `docker compose down` stops it and retains
its database. `docker compose down -v` deletes the test database; run that only
when you intend to remove this dedicated instance's data.

## Maintainer checks

```sh
sh examples/check.sh
terraform -chdir=examples/demo/terraform init -backend=false
terraform -chdir=examples/demo/terraform validate
kubectl kustomize examples/demo
```

The check script exercises the copied page over HTTP and verifies repeatable
version changes without external accounts. The Terraform guide covers an actual
apply/change/destroy, and the ArgoCD guide covers an actual reconciliation.
