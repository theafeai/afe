# Read-only ArgoCD account and token for Afe

Afe reads ArgoCD's API with a dedicated **local account** that can only `get`
applications, projects and clusters. It never syncs, deletes or runs actions.

References: [User management](https://argo-cd.readthedocs.io/en/stable/operator-manual/user-management/),
[RBAC configuration](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/),
[`argocd account generate-token`](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_account_generate-token/).

> ArgoCD instances Afe cannot reach can use the **in-cluster agent** instead:
> no ArgoCD account or token at all, only a Kubernetes ServiceAccount and an
> agent secret. See [In-cluster agent secret](#in-cluster-agent-secret) below.

## 1. Create a local account with API-key capability only

Edit the `argocd-cm` ConfigMap in ArgoCD's namespace (usually `argocd`):

```sh
kubectl -n argocd patch configmap argocd-cm --type merge \
  -p '{"data":{"accounts.afe":"apiKey","accounts.afe.enabled":"true"}}'
```

`apiKey` (without `login`) means the account can use tokens but cannot sign in
to the UI.

## 2. Grant a read-only role

Add a role to `argocd-rbac-cm` (merge with your existing `policy.csv`; do not
overwrite it):

```csv
p, role:afe-readonly, applications, get, */*, allow
p, role:afe-readonly, projects, get, *, allow
p, role:afe-readonly, clusters, get, *, allow
g, afe, role:afe-readonly
```

For example:

```sh
kubectl -n argocd edit configmap argocd-rbac-cm
# under data.policy.csv, append the four lines above
```

The built-in `role:readonly` also works (`g, afe, role:readonly`) but grants
more (e.g. repositories, logs) than Afe uses. Never grant `role:admin`, `sync`,
`override`, `action`, `update`, `delete` or `exec`
([security rules R1](../../security/rules.md#r1--least-privilege-read-only-everywhere)).

To limit Afe to some projects, replace `*/*` with `<project>/*` and `*` with the
project names.

Check the policy:

```sh
argocd admin settings rbac can afe get applications '*/*' --namespace argocd   # Yes
argocd admin settings rbac can afe sync applications '*/*' --namespace argocd  # No
```

## 3. Generate a token

As an ArgoCD admin:

```sh
argocd login <argocd-host>
argocd account generate-token --account afe --expires-in 90d
```

Give the token an expiry and put a reminder in your calendar to rotate it.
Copy it straight into Afe (step 4); do not save it in files or shell history.

## 4. Give the server URL and token to Afe

Afe needs the ArgoCD server URL (`https://argocd.internal.example.com`) and the
token. The token is stored encrypted in Afe's database.

> **To be finalised when AFE-9 lands.**

Network notes:

- An internal ArgoCD (private IP) requires `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`
  in `.env` (outbound calls to private networks are refused by default).
- A private CA: configure it rather than disabling verification, either per
  connection (pending AFE-9) or process-wide by mounting the PEM bundle and
  setting `NODE_EXTRA_CA_CERTS=/run/secrets/argocd-ca.pem` (CA certificates are
  not secret, any read-only mount works).
- Plain `http://` ArgoCD URLs additionally need
  `AFE_ALLOW_INSECURE_HTTP_TARGETS=true`; lab setups only.
- ArgoCD needs no inbound access to Afe.

## Rotating and revoking

- **Rotate**: generate a new token (step 3), enter it into Afe, then delete the
  old one: `argocd account get --account afe` lists token ids;
  `argocd account delete-token --account afe <id>`.
- **Revoke**: delete the tokens, or set `accounts.afe.enabled: "false"`. Afe
  marks the connection unhealthy and records an observation gap.

## In-cluster agent secret

With the in-cluster agent ([docs/connectors/argocd.md](../../connectors/argocd.md#in-cluster-agent))
Afe needs no ArgoCD token. The agent reads Applications with a Kubernetes
ServiceAccount (get/list/watch `applications.argoproj.io`, get/list `events`;
nothing else, no Secrets) and authenticates to Afe with a per-agent secret.

- **Create**: `POST /api/connections/argocd/agents` (admin) returns `agentId`
  and `secret` once. Afe keeps it encrypted (credential kind
  `argocd_agent_secret`, role `agent_secret`).
- **Store** it only in a Kubernetes Secret, never in Helm values or a
  ConfigMap:

  ```sh
  kubectl create namespace afe-argocd-agent
  kubectl -n afe-argocd-agent create secret generic afe-argocd-agent \
    --from-literal=secret="$AGENT_SECRET"
  ```

  The agent reads it from the mounted file (`AFE_AGENT_SECRET_FILE`). The
  secret is only used to compute an HMAC; it is never sent to Afe or logged.

- **Rotate** without downtime: `POST /api/connections/argocd/agents/<id>/rotate-secret`
  with `{"graceSeconds": 3600}` returns the new secret and keeps the old one
  valid for the grace period. Update the Kubernetes Secret
  (`kubectl -n afe-argocd-agent create secret generic afe-argocd-agent --from-literal=secret=... --dry-run=client -o yaml | kubectl apply -f -`);
  the agent re-reads the file on every request (Secret volume updates reach
  the pod within about a minute), so no restart is needed. Without
  `graceSeconds` the old secret stops working immediately.
- **Revoke**: `DELETE /api/connections/argocd/<id>` revokes the secret and
  disconnects the agent; its requests are then rejected with 401. Remove the
  Deployment and the RBAC objects from the cluster.
- **Clock**: requests are signed with a timestamp and rejected when more than
  5 minutes away from Afe's clock; keep the nodes' time synchronised (NTP).
