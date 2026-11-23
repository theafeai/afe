# AFE-58 browser verification

The screenshots use the actual production web bundle, Afe API, browser-session
CSRF, and PostgreSQL. Vercel is a local deterministic fake; no live Vercel project
or deployment was changed. No credentials appear in these artifacts.

Verified: session login → discover selected project → enable a separate personal
action token with explicit operations → select an individual deployment → prepare
→ overlay confirmation → confirmed redeploy → accepted PostgreSQL receipt → new
build ID in the refreshed workspace. `browser-evidence.json` records route/status
observations and page errors (none).

| View         | Light desktop                     | Dark desktop                    | Light 390px                      | Dark 390px                     |
| ------------ | --------------------------------- | ------------------------------- | -------------------------------- | ------------------------------ |
| Workspace    | [light](workspace-light-1440.png) | [dark](workspace-dark-1440.png) | [light](workspace-light-390.png) | [dark](workspace-dark-390.png) |
| Confirmation | [light](confirm-light-1440.png)   | [dark](confirm-dark-1440.png)   | [light](confirm-light-390.png)   | [dark](confirm-dark-390.png)   |

The shared OperationDialog supplies focus capture/restoration, keyboard Escape,
backdrop handling and synchronous duplicate-click suppression. UI tests additionally
cover empty/error discovery, explicit credential consent, confirmation before
mutation and uncertain outcomes. API tests use fake Vercel responses for all
mutations, permission/tenant boundaries, stale state, concurrency, CSRF, receipt
binding/recovery, provider failures and retention without observed events.
