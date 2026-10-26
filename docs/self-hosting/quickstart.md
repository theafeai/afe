# Quickstart: Afe with docker compose

Goal: in about 15 minutes, a running Afe on your machine, receiving events from
a test GitHub organization.

You need:

- Docker Engine 24+ with the Compose plugin (`docker compose version`), on
  Linux, macOS or Windows (WSL2). `linux/amd64` and `linux/arm64` are supported.
- `openssl` and `curl`.
- Owner rights on a **test** GitHub organization (create a free one if needed).
- A way for GitHub to reach your machine over HTTPS (step 5): a public server,
  a reverse proxy, or a tunnel such as Cloudflare Tunnel or ngrok.

## 1. Get the compose file (1 min)

```sh
mkdir afe && cd afe
VERSION=v0.1.0   # pick the latest release: https://github.com/theafeai/afe/releases
curl -fsSLO https://raw.githubusercontent.com/theafeai/afe/$VERSION/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/theafeai/afe/$VERSION/.env.example -o .env.example
```

(Or `git clone https://github.com/theafeai/afe` and work in the checkout.)

## 2. Generate the encryption key (1 min)

Afe encrypts every stored credential (GitHub App private key, tokens, webhook
secrets) with this key. Docker Compose mounts it into the containers as a secret
file.

```sh
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/afe_encryption_key
chmod 644 secrets/afe_encryption_key   # readable by the container user; the 700 directory keeps others out
```

**Back this key up now**, somewhere other than where your database backups go
(a password manager is fine). Without it, stored credentials cannot be
decrypted; see [secrets](secrets.md).

## 3. Configure (1 min)

```sh
cp .env.example .env
sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env && rm .env.bak
sed -i.bak "s/^AFE_VERSION=.*/AFE_VERSION=${VERSION#v}/" .env && rm .env.bak
```

Pinning `AFE_VERSION` to a release (instead of `latest`) means upgrades only
happen when you choose. Every other setting has a safe default; see the
[configuration reference](configuration.md).

## 4. Start (2 min)

```sh
docker compose up -d --wait
curl -s http://127.0.0.1:8080/healthz      # {"status":"ok"}
```

This starts PostgreSQL, `afe-server` and `afe-worker`. Database migrations run
automatically on start. Open <http://127.0.0.1:8080/> for the web UI.

The port is bound to `127.0.0.1` only. The UI and API are not meant to be on the
internet; from another machine use an SSH tunnel
(`ssh -L 8080:127.0.0.1:8080 your-server`).

If something fails: `docker compose logs afe-server afe-worker`.

## 5. Make the webhook endpoint reachable (3 min)

GitHub delivers events to `https://<your-host>/webhooks/github`. Expose **only**
`/webhooks/*` over HTTPS; see [webhooks behind a firewall](webhooks-behind-firewall.md)
for a Caddy/nginx config and tunnel options. For a quick test with a tunnel:

```sh
# Cloudflare quick tunnel (no account needed); prints https://<random>.trycloudflare.com
cloudflared tunnel --url http://127.0.0.1:8080
```

A quick tunnel exposes every path; use it only for a short test and switch to
a path-restricted proxy for anything longer-lived. Note the public URL
(`<public-url>` below).

Even without inbound webhooks Afe still records deployments: reconciliation
polling picks them up later and records the gap.

## 6. Create the GitHub App and install it (5 min)

Follow [GitHub App setup](credentials/github-app.md):

1. Create a GitHub App owned by your test organization with read-only
   permissions and the webhook URL `<public-url>/webhooks/github`.
2. Generate a webhook secret and a private key.
3. Install the app on the test organization (all or selected repositories).
4. Give Afe the App ID, private key and webhook secret.

> Step 4 (how the credentials are entered into Afe: UI, API or CLI) is
> **to be finalised when AFE-6 (GitHub App connector) lands**.

## 7. See an event (2 min)

Trigger a deployment-related action in a test repository, for example run a
GitHub Actions workflow (`workflow_dispatch`) or create a deployment, then:

- the GitHub App's **Advanced → Recent Deliveries** page shows a `2xx` response;
- `docker compose logs afe-worker` shows the job being processed;
- the event appears in the Afe UI / API.

> Querying events from the UI and API is **to be finalised when AFE-14 (query
> API) lands**.

## Next steps

- Connect [ArgoCD](credentials/argocd.md) and [Vercel](credentials/vercel.md).
- Set up [backups](operations.md#backups) and read the [upgrade guide](operations.md#upgrades).
- Review [secrets handling](secrets.md) and the [threat model](../security/threat-model.md).
- Stop everything with `docker compose down` (data stays in the `afe-pgdata`
  volume; `docker compose down -v` deletes it).
