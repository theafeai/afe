# Connection lifecycle events

Afe records connection lifecycle actions in the Events list with `source: afe`
and a connection target. They use the normal event API, filters and retention
window. Disconnecting a connection revokes access but keeps its row and retained
events; it does not delete event history. Existing events are immutable, so this
fix does not rewrite older events whose actor was unknown.

## Coverage verified for AFE-64

| Connection                 | Created                                            | Lost                                                                               | Deleted                                                                                                                      |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GitHub App                 | Afe setup callback and source installation webhook | Health failure opens a gap and emits `connection.lost`                             | Afe disconnect emits `connection.deleted`; source uninstall emits `connection.deleted` and the existing `connection.revoked` |
| ArgoCD pull                | Successful verified setup                          | Probe, watch or reconciliation failure                                             | Afe disconnect                                                                                                               |
| ArgoCD agent               | Agent registration                                 | Missing heartbeat or reported observation failure                                  | Afe disconnect through the ArgoCD route                                                                                      |
| Vercel token / integration | Successful setup                                   | Health failure, including detected credential revocation                           | Afe disconnect; integration-removal webhook                                                                                  |
| Terraform reporter         | Reporter registration                              | Reported health failures only; there is no source API probe or inactivity deadline | Afe disconnect                                                                                                               |

Before this fix, only GitHub wrote connection lifecycle events. Other connectors'
setup and disconnect routes did not emit them. Loss was represented by
`observation_gap.opened`, without a `connection.lost` action.

`connection.lost` now accompanies each newly opened failure gap, once per gap.
Repeated failures do not create more lost events. The lost event's timestamp is
when failure was detected; the gap starts at the last successful observation.
Recovery still emits `observation_gap.closed`. Afe downtime inferred after
restart remains a retrospective observation gap, rather than a live connection
loss. Health monitoring must be enabled and running to detect failures.

## Two separate identities

The **Afe actor** is the authenticated principal performing setup or disconnect.
It comes from server authentication, never request body fields. Local-user
sessions preserve the user's name/id. Bootstrap admin tokens have only a stable
principal fingerprint, not an independently known personal username.

The **credential owner** is an upstream identity, displayed separately in the
Events list and event detail. Its public identity fields are in
`data.credentialOwner`; credentials are never included.

| Credential                        | Identity available                                                | Limitation                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ArgoCD API token                  | Username from verified user-info during the connection test       | An agent's ArgoCD token stays in its cluster, so registration cannot resolve its owner                                             |
| Vercel access token               | User id and username from `GET /v2/user`                          | Existing setup validation still requires that endpoint                                                                             |
| Vercel integration OAuth          | User id from code exchange; username from user API when permitted | Team-scoped integration tokens may not permit user lookup; connect succeeds with the exchange user id                              |
| GitHub App                        | App id; installation account recorded separately                  | App installation tokens belong to the App, not a human token owner; organization/installer is not reported as the credential owner |
| ArgoCD agent / Terraform reporter | Unavailable                                                       | Afe generates an HMAC secret; it has no upstream user account                                                                      |

GitHub setup previously constructed an event without its authenticated principal,
so it defaulted to `unknown`. Setup now writes an Afe actor event independently
of the source installation webhook. These are separate actions and may both be
shown, regardless of arrival order. Source webhooks retain the source-reported
actor (or unknown when the source omits it); system-detected losses use a system
actor. Repeating a GitHub callback for the same signed flow is idempotent.

Connection changes and pending event payloads commit together in the existing
health outbox. Delivery happens after commit, avoiding foreign-key waits on
uncommitted connections. The health worker retries pending events even for
revoked or disconnected connections. Custom compositions omitting the health
module must provide an outbox drain if they need retries after sink failures.

Validation uses PostgreSQL and local fake source APIs: setup/disconnect event
persistence and attribution, GitHub callback/webhook arrival order and replay,
one lost event per gap, deferred sink delivery, and UI identity labels. No live
provider credentials or APIs are used by these tests.

## Administrator disconnect (AFE-67)

Administrators can disconnect from the Connections list or connection detail, after
reviewing a source-specific warning and choosing **Disconnect connection**. Cancel
or Escape leaves the connection unchanged. Requests use the existing authenticated,
CSRF-protected admin routes. Success refreshes status; failures remain in the dialog
and can be retried.

GitHub supports a local disconnect: observation and webhook processing stop, cached
installation tokens are invalidated, and the installation stays disconnected even
when later installation webhooks arrive. The App remains installed on GitHub and
shared App credentials are preserved. An administrator can reconnect through Afe's
setup flow. Other connectors revoke their stored credentials; Vercel additionally
attempts integration removal, while Terraform removes pending reports. External
tokens, agents or reporter configuration may need manual removal, as the warning
and result explain. All recorded events remain subject to normal retention.
