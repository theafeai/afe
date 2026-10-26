# Webhooks behind a firewall

GitHub and Vercel push events to Afe by webhook. If your Afe instance is on a
private network, you have two choices: expose **only** the webhook endpoints
safely, or receive no webhooks and rely on reconciliation polling.

ArgoCD does not need inbound webhooks: Afe reads its API (outbound from Afe),
and ArgoCD is usually internal anyway (set `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`).

## What to expose

| Path                    | Expose?                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `POST /webhooks/github` | Yes, if you use GitHub webhooks                                     |
| `POST /webhooks/vercel` | Yes, if you use Vercel webhooks                                     |
| everything else         | **No.** UI, API and `/healthz` stay on your private network or VPN. |

Requirements for the public endpoint:

- **HTTPS** with a publicly trusted certificate (GitHub and Vercel require it
  for secure delivery).
- Only `POST`, only `/webhooks/*`.
- A request body limit of at least 25 MB (GitHub's maximum payload size).

## Why exposing the webhook path is safe

Every delivery is checked before Afe stores or processes it
([security rules R3](../security/rules.md#r3--webhook-authenticity-and-replay-rejection)):

- **Signature verification** over the exact request bytes: GitHub's
  `X-Hub-Signature-256` (HMAC-SHA256) and Vercel's `x-vercel-signature`, with
  constant-time comparison. Missing or invalid signatures get `401` and are not
  stored. Only someone with the webhook secret can produce a valid delivery.
- **Replay rejection**: each delivery id is recorded; a repeated delivery is
  acknowledged but not processed again. Where the source signs a timestamp,
  stale deliveries are rejected.
- **Idempotent ingestion**: the same event arriving by webhook and by polling
  is stored once.
- The handler only verifies, records and enqueues; no outbound calls or heavy
  work happens on the request path.

Use a strong webhook secret (`openssl rand -hex 32`), different per source.

Optionally restrict source IPs at the proxy too: GitHub publishes its webhook
source ranges in the `hooks` list of <https://api.github.com/meta> (they change;
automate updates). Vercel does not publish fixed ranges, so rely on signatures.
IP filtering is defence in depth, not a replacement for signature checks.

## Option 1: reverse proxy (public host or DMZ)

Afe listens on `127.0.0.1:8080` (compose default). Put the proxy on the same
host.

Caddy (automatic HTTPS):

```caddyfile
afe-hooks.example.com {
	@webhooks {
		method POST
		path /webhooks/*
	}
	handle @webhooks {
		request_body {
			max_size 25MB
		}
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		respond 404
	}
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name afe-hooks.example.com;
    ssl_certificate     /etc/ssl/afe-hooks.crt;
    ssl_certificate_key /etc/ssl/afe-hooks.key;

    location /webhooks/ {
        limit_except POST { deny all; }
        client_max_body_size 25m;
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
    location / { return 404; }
}
```

Do not let the proxy rewrite or re-encode the body (no compression or JSON
transformation filters): signatures are computed over the exact bytes.

## Option 2: outbound tunnel (no inbound firewall rule)

A tunnel agent next to Afe opens an outbound connection to a provider, which
receives the HTTPS traffic for you:

- **Cloudflare Tunnel** (`cloudflared`): create a named tunnel with a public
  hostname mapped to `http://127.0.0.1:8080`, and add a WAF custom rule that
  blocks every request whose path does not start with `/webhooks/` or whose
  method is not `POST`.
- **ngrok**: use a reserved domain and a traffic policy that only allows
  `POST` to `/webhooks/*`.
- **Tailscale Funnel**: `tailscale funnel --set-path /webhooks/ http://127.0.0.1:8080/webhooks/`
  exposes only that path.

Quick, unrestricted tunnels (`cloudflared tunnel --url ...`) expose every path;
use them for a short test only.

## Option 3: no inbound webhooks, polling only

If nothing can reach Afe, leave the webhook URL out (or disable the webhook)
and rely on reconciliation polling. Afe periodically lists recent deployments,
workflow runs and application history through each tool's API (outbound only)
and ingests anything it has not seen, marked as discovered by
reconciliation. Because ingestion is idempotent, webhooks and polling never
produce duplicates.

The trade-off is latency: events appear after the next reconciliation run
instead of within seconds. When a webhook endpoint is configured but deliveries
stop (firewall change, outage), reconciliation fills the gap and Afe records an
observation gap for the period, so missing data is flagged rather than silent.

> Polling intervals, how gaps are opened and closed, and how to see them are
> **to be finalised when AFE-13 (connection health) lands**; per-source
> reconciliation coverage when AFE-6 (GitHub), AFE-9 (ArgoCD) and AFE-11
> (Vercel) land.

## Checking deliveries

- GitHub: the App's settings page, **Advanced → Recent Deliveries**, shows each
  delivery's response and lets you redeliver.
- Vercel: the webhook's delivery log in team settings.
- Afe: `docker compose logs afe-server | grep webhooks` shows source, delivery
  id and the reason for any rejection (never the signature or body).
