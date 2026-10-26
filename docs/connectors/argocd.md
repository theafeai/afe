# Connecting ArgoCD

Afe connects to ArgoCD read-only, in **pull mode**: it calls the ArgoCD API
with an API token of a dedicated account. You can connect any number of ArgoCD
instances. Design and alternatives: [ADR 0004](../decisions/0004-argocd-connection-model.md).

## 1. Create a dedicated read-only account

In `argocd-cm`, add a local account with **only** the `apiKey` capability (no
`login`, so it cannot use the UI or password login):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  accounts.afe: apiKey
```

In `argocd-rbac-cm`, give it a read-only role:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    p, role:afe-readonly, applications, get, */*, allow
    p, role:afe-readonly, projects, get, *, allow
    p, role:afe-readonly, clusters, get, *, allow
    g, afe, role:afe-readonly
```

| Policy line         | Why Afe needs it                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `applications, get` | List and watch applications; read sync status, operation state and history (who synced which revision). Required.          |
| `projects, get`     | Resolve project names/destinations for the audit target. Optional; drop it if you do not want Afe to see project settings. |
| `clusters, get`     | Map destination server URLs to cluster names. Optional; Afe falls back to the destination URL.                             |
| `g, afe, role:...`  | Binds the account to the role.                                                                                             |

The built-in `role:readonly` also works, but grants more reads than needed
(repositories, certificates, GPG keys, accounts, logs on some versions).

**Deliberately not granted** (Afe would reject the token if it had them):

- `applications, sync` / `override` / `action/*` / `update` / `create` /
  `delete`: these deploy, roll back, run resource actions or change apps. Afe
  observes deployments and must never be able to cause one.
- `exec, create`: opens a shell in workloads.
- `logs, get`: pod logs routinely contain secrets; Afe never stores logs
  (data inventory). Afe accepts the token but warns if this is allowed.
- `repositories`, `certificates`, `gpgkeys`, `accounts`: not needed.

Make sure `policy.default` in `argocd-rbac-cm` is empty or `role:readonly` at
most; a broader default role would apply to the Afe account too.

## 2. Generate a token

```sh
argocd login argocd.example.com --sso   # or as admin
argocd account generate-token --account afe --id afe-$(date +%Y%m) --expires-in 8760h
```

Store the token only in Afe. To rotate: generate a new token, reconnect
(Afe replaces and revokes the stored one), then
`argocd account delete-token --account afe <old-id>`.

**SSO (Dex or OIDC):** API tokens of local accounts are independent of SSO,
so this works unchanged when users log in through SSO. You can keep
`admin.enabled: "false"`; generate the token while logged in via SSO as a user
whose role may manage accounts (`accounts, update`).

## 3. Connect in Afe

```sh
curl -X POST http://afe.internal:8080/api/connections/argocd \
  -H 'content-type: application/json' \
  -d '{"url":"https://argocd.example.com","token":"<token>","name":"prod-eu","caPem":"<optional PEM>"}'
```

Afe then:

1. validates the URL (`https` only; private addresses need
   `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true` on a self-hosted Afe),
2. calls `GET /api/version`, `GET /api/v1/session/userinfo`,
   `GET /api/v1/applications` (names only),
3. runs the **read-only check**: `GET /api/v1/account/can-i/<resource>/<action>/<object>`
   for `applications` `sync`/`override`/`update`/`delete`/`create` and `exec create`,
   on `*`, `*/*` and up to five real `project/app` objects, plus `logs get`.
   Any write capability → `422 token_not_read_only` and nothing is stored. If
   `can-i` is unavailable the connection is saved with a warning,
4. stores the token encrypted (credential kind `argocd_api_token`) and the
   connection as `active`.

Other endpoints:

| Method and path                         | Effect                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `GET /api/connections/argocd`           | List ArgoCD connections (never returns tokens).         |
| `POST /api/connections/argocd/:id/test` | Re-run the checks with the stored token.                |
| `DELETE /api/connections/argocd/:id`    | Revoke (destroy) the stored token, mark `disconnected`. |

Connecting the same URL again updates the connection in place (same id, so
history stays linked) and revokes the previous token.

> The admin API has no authentication yet (ADR 0002 `AuthProvider`). Do not
> expose the Afe API outside a trusted network until it does.

## TLS: private CA or self-signed certificate

Pass the CA certificate (or the self-signed server certificate) as `caPem`.
It is added to the default trust store for this connection only; verification
always stays on. Alternatively set `NODE_EXTRA_CA_CERTS` for the whole
process. `--insecure`-style options do not exist in Afe.

## Network

Afe needs HTTPS reach to the ArgoCD API (the same URL the `argocd` CLI uses;
gRPC-web is not needed). Use the final URL: Afe does not follow redirects.
For instances Afe cannot reach, an outbound in-cluster agent is designed in
ADR 0004 but not yet available.

## What Afe reads and stores

Reads: application metadata, spec source/destination/project, sync and health
status, operation state and history. Never manifests, resource trees, logs or
Secrets. Stored config: server URL, CA bundle, ArgoCD version, account name,
read-only check result. Event capture (watch + reconciliation) is AFE-10.
