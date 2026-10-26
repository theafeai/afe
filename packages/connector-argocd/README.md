# @afe/connector-argocd

Read-only ArgoCD connector: REST client (GET only, bearer token, per-connection
CA, SSRF-safe DNS lookup, no redirects), connection test with a read-only
check, and a generic SSE reader for watch streams.

## Permissions requested (rules.md R1.2)

A dedicated local account with only the `apiKey` capability, bound to:

```
p, role:afe-readonly, applications, get, */*, allow   # required: app status, operation state, history
p, role:afe-readonly, projects, get, *, allow         # optional: project names/destinations
p, role:afe-readonly, clusters, get, *, allow         # optional: cluster names
g, afe, role:afe-readonly
```

No `sync`, `override`, `action`, `update`, `create`, `delete`, `exec` or
`logs`. Tokens with write capabilities are rejected. Full setup:
[docs/connectors/argocd.md](../../docs/connectors/argocd.md); design:
[ADR 0004](../../docs/decisions/0004-argocd-connection-model.md).

`@afe/connector-argocd/testing` exports a fake ArgoCD HTTPS server for tests.
