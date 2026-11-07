# ADR 0016: Opt-in ArgoCD application delivery actions

- Status: Accepted (authorized by AFE-56/AFE-59)
- Date: 2026-11-07
- Extends ADR 0011 and the Source-only boundary of ADR 0015

## Decision

The explicit R1 action-route exception extends to the catalog in
[ArgoCD operations](../argocd-actions.md). A dedicated action transport supports
only the enumerated application operations; the existing observer client and
in-cluster agent stay read-only. No generic provider proxy, Kubernetes exec or
shell is added. No observer token can become an action credential.

Actions use an explicitly linked personal ArgoCD token or OIDC identity for an
active tenant-owned connection. Source mode, a non-disabled managed user,
current application read permission, exact action RBAC and per-link opt-in
consent are required. Neither bootstrap authority nor a successful observation
probe implies write permission. OIDC expiry/configuration revisions, credential
revocation, application UID/namespace and source state are checked at use time.

The UI and authenticated API share one typed catalog and strict schema. The
GitHub prepare/confirm/digest/UUID/receipt contract is reused. Receipts are written
before dispatch, include only minimized actor/target/action/outcome evidence and
expire under tenant retention. Every provider mutation, including refresh's GET,
is sent once. Uncertainty stays locked until the original actor acknowledges
possible duplication; in-flight recovery waits at least two minutes. Accepted
means upstream acceptance, never lifecycle completion. Sync-policy patches test
the source resourceVersion; other APIs can race external changes after validation.

Resource diff payloads are reduced in memory to resource identities and changed
flags. Raw desired/live manifests, secret values, arbitrary application patches,
local manifest overrides and parameterized custom actions are not exposed by this
catalog. Their review and agent-mode transport are explicit follow-up scopes in
the capability matrix. Existing ingestion and AFE-54 source logs remain separate.
