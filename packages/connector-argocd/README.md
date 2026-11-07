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

## Optional application operations

[ArgoCD operations](../../docs/argocd-actions.md) documents the capability matrix, API and setup.
Keep this connection's collector token read-only. Operations use a separate,
linked personal identity, current source RBAC and explicit per-link consent;
`get` enables observation, `sync` enables sync/rollback/termination,
`action/<group>/<kind>/<name>` enables a specific resource action, `update` enables
sync-policy changes and `delete` enables application deletion. Grant only the
project/application operations that identity needs. The original GET-only client
and outbound agent never use the action transport.
