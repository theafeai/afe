# ADR 0011: Opt-in delivery actions

- Status: Accepted (product direction authorized by AFE-56)
- Date: 2026-10-28
- Issues: AFE-56, AFE-57

## Decision

Afe supports delivery actions as well as observation. This supersedes R1's
blanket prohibition on mutations only for explicitly implemented action routes.
Existing connector read clients, App manifests, installation token narrowing,
webhooks and reconciliation retain their read-only behavior.

The first GitHub slice uses a managed user's existing encrypted personal OAuth
credential, never the observation App token. It requires a separate, exact
repository/action grant from the administrator AND current upstream write access.
Source read access, custom read grants and the legacy admin token alone cannot
mutate GitHub. No OAuth scopes or App permissions are automatically expanded.
The linked OAuth token's existing `repo` scope may permit writes, but Afe does
not invoke a mutation without the explicit action grant. Future narrower token
options and hosted principal mapping remain AFE-57 follow-ups.

All action requests use the normal authentication, tenant resolution, Origin and
CSRF hooks. UI confirmation and structured API intent include the current attempt.
Provider state and permissions are rechecked before submitting. GitHub's run
control API has no atomic expected-attempt precondition; a concurrent external
re-run between that check and submission remains a provider limitation.

Persist an operational receipt before submission. A unique key suppresses repeated
operations on an attempt across events, users, request IDs and server restarts;
re-run-all and re-run-failed are mutually exclusive. Never retry an upstream
mutation automatically. Network/5xx failures are uncertain, and a crash can leave
a requested receipt: either blocks another submission until the source state
advances. An explicit rejected request also remains blocked for that attempt in
this initial slice; retry/reset UX requires separate design, not silent retries.

Operational receipts contain actor, target, operation and acceptance state only.
They are subject to the tenant retention window and are not a long-term audit
feature (ADR 0008). Acceptance is not deployment completion. Existing source events
and reconciliation determine completion; no synthetic success event is ingested.

## Coordination with source logs

AFE-51/52 own log collection, streaming, forwarding, buffering and rendering.
The action module is additive and does not touch these paths. Its response context
contains `connectionId`, `repository`, `runId`, `runAttempt`; future job actions
also carry `jobId`. Re-running does not reassign the prior attempt's log stream.
