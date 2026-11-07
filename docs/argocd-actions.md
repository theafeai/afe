# ArgoCD application operations

AFE-59 adds an ArgoCD workspace at `/argocd` and an authenticated API with the
same catalog, source permission checks, validation and operational receipts.
The original collector and outbound agent remain read-only. This is an explicit
opt-in exception to R1, documented in [ADR 0016](decisions/0016-argocd-delivery-actions.md).

## Capability matrix

API shapes are checked against ArgoCD v2.14.11's published
[OpenAPI definition](https://github.com/argoproj/argo-cd/blob/v2.14.11/assets/swagger.json).
A supported row is always permission-gated: the tenant-owned connection must be
active, the caller must have Source mode and a linked personal credential for
that exact connection, and ArgoCD must allow reading the application. Actions
also require explicit per-link consent and the exact permission shown below.
The provider performs its own final RBAC and sync-window checks.

| Native operation                                                                                                                                                  | Direct connection                                                             | Source permission / constraints                                                                                     | Outbound agent                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| List applications; application sync, health, revision and current operation                                                                                       | Supported                                                                     | `applications,get`                                                                                                  | Existing observation only; live workspace deferred F1 |
| Refresh / hard refresh                                                                                                                                            | Supported, confirmed even though ArgoCD uses GET                              | `applications,get`, plus explicit action consent                                                                    | Deferred F1                                           |
| Sync configured revision or a selected revision                                                                                                                   | Supported                                                                     | `applications,sync`; automatic sync and sync windows still enforced upstream                                        | Deferred F1                                           |
| Multi-source revisions                                                                                                                                            | Supported in source order, all positions                                      | `applications,sync`; arbitrary subset positions deferred F2                                                         | Deferred F1                                           |
| Selective resource sync                                                                                                                                           | Supported                                                                     | Exact resource membership; `applications,sync`                                                                      | Deferred F1                                           |
| Prune, dry run, force hook strategy                                                                                                                               | Supported                                                                     | Explicit confirmation of exact inputs                                                                               | Deferred F1                                           |
| Sync options: validation, namespace creation, prune ordering/propagation, out-of-sync only, ignore differences, server-side apply, replace, shared-resource check | Supported fixed allowlist                                                     | Strict schema; arbitrary/version-specific options deferred F2                                                       | Deferred F1                                           |
| Apply-only strategy, custom retry/backoff policy, local manifest override, resource exclusions                                                                    | Deferred F2                                                                   | Local manifest override also needs `override` and a data-minimization decision                                      | Deferred F1/F2                                        |
| Deployment history selection and rollback                                                                                                                         | Supported                                                                     | `applications,sync`; history entry must exist; automatic sync disabled; idle application                            | Deferred F1                                           |
| Terminate current operation                                                                                                                                       | Supported                                                                     | `applications,sync`; running operation only                                                                         | Deferred F1                                           |
| Discover and execute custom/built-in resource actions, e.g. restart/resume                                                                                        | Supported for actions without parameters                                      | Exact `applications,action/<group>/<kind>/<name>`, resource belongs to app, source action enabled, idle application | Deferred F1                                           |
| Parameterized resource actions                                                                                                                                    | Deferred F2; visibly disabled                                                 | No arbitrary action payloads accepted                                                                               | Deferred F1/F2                                        |
| Change automatic sync, prune, self-heal, allow-empty                                                                                                              | Supported                                                                     | `applications,update`; JSON Patch tests `metadata.resourceVersion` atomically                                       | Deferred F1                                           |
| Delete application, cascade on/off, foreground/background propagation                                                                                             | Supported                                                                     | `applications,delete`; idle app; confirmation explicitly names cascade effects                                      | Deferred F1                                           |
| Create/upsert application; edit project, sources/revisions, destination, parameters, metadata, finalizers, full spec                                              | Deferred F2                                                                   | Project/cluster/repository validation and GitOps ownership preview needed; arbitrary patches not accepted           | Deferred F1/F2                                        |
| Delete/patch a managed resource                                                                                                                                   | Deferred F2                                                                   | Requires a separate resource mutation schema/preview and fine-grained provider permissions                          | Deferred F1/F2                                        |
| Per-resource sync/health and changed/no-difference summary                                                                                                        | Supported                                                                     | `applications,get`; source diff payloads are transient and reduced to identity + changed flag                       | Existing observed health; live diff deferred F1       |
| Field-level desired/live diff, full manifests/resource tree details, revision metadata and Kubernetes event drill-down                                            | Deferred F2                                                                   | Existing immutable application event timeline remains available; raw manifests may contain secrets                  | Deferred F1/F2                                        |
| Delete deployment history                                                                                                                                         | Deferred F2, if supported by target version                                   | Requires version-specific supported API verification                                                                | Deferred F1/F2                                        |
| Sync-window visibility / overrides                                                                                                                                | Provider enforces windows; local controls deferred F2                         | No bypass of project policy                                                                                         | Deferred F1/F2                                        |
| Native log tail / container logs                                                                                                                                  | Separate [AFE-54](https://linear.app/theafe/issue/AFE-54)                     | No log transport, buffering or viewer added here                                                                    | Separate AFE-54                                       |
| Pod exec / terminal                                                                                                                                               | Unsupported by this action catalog; no remote shell                           | Requires a separate reviewed capability; never inferred from observation                                            | Unsupported                                           |
| Project/cluster/repository/account/ApplicationSet administration                                                                                                  | Outside application-delivery scope, explicit deferred F2 review before adding | No generic provider API proxy                                                                                       | Unsupported                                           |

### Follow-up F1: outbound-agent actions

The existing heartbeat/batch/resync protocol transports observations, not remote
commands. Add a separate opt-in action protocol with personal source identity,
least-privilege credentials kept inside the cluster, bound connection/application
UID/namespace/operation identifiers, expiry, deduplication, revocation and
sanitized receipts. Verify stale state, command replay and transport loss. Keep
logs separate under AFE-54. Until then agent connections explicitly return an
observation-only explanation; their observer credentials cannot dispatch.

### Follow-up F2: advanced lifecycle and safe configuration

Track every deferred direct-connection row above here until it has its own
implementation issue. Add typed schemas and safe previews before create/upsert,
full-spec/metadata/source edits or managed-resource writes. Handle ApplicationSet
and GitOps ownership. Define a reviewed redaction policy before returning raw
field diffs/manifests or accepting local overrides. Expand provider-version
coverage before retry strategies, arbitrary sync options, subset source positions,
parameterized actions, history deletion and sync-window controls. Each addition
must use the same authorization, confirmation, concurrency and failure tests.

These follow-up scopes are tracked in this document with the matrix; the current
implementation does not claim complete native parity.

## Installation and permissions

1. Keep the connection's dedicated collector account read-only, as described in
   [ArgoCD credentials](self-hosting/credentials/argocd.md). Never attach an action
   token to `connection_credentials.api_token` or elevate the observer.
2. An administrator enables **Linked tool account** (Source) for the managed
   user's ArgoCD tool. Missing/None and legacy Custom modes deny access.
3. The user links their personal ArgoCD API token or signs in through configured
   OIDC in **Profile**, selecting the connection. Personal credentials are encrypted
   through the existing credential repository. OIDC expiry/configuration revision
   are rechecked; replacement/unlink destroys old credentials and resets consent.
4. Open **ArgoCD**, select an application and choose **Enable actions**. This consent
   applies only to the current personal account link, never to the observer.
5. Limit the identity's ArgoCD RBAC to selected projects/apps and needed actions.
   For example, a user who needs sync and restart does not need update or delete:

```csv
p, role:afe-operator, applications, get, delivery/web, allow
p, role:afe-operator, applications, sync, delivery/web, allow
p, role:afe-operator, applications, action/apps/Deployment/restart, delivery/web, allow
```

For applications outside the controller namespace, ArgoCD uses
`<project>/<namespace>/<application>` rather than `<project>/<application>`.
The controller namespace defaults to `argocd`; installations with a different
controller namespace can set the connection's non-secret `controllerNamespace`
configuration to its actual namespace. Both discovery and dispatch still use
the source's authorization; there is no fallback to the collector credential.
Static administrator/viewer API tokens alone cannot act as a personal identity;
authenticated agents use a managed user's Afe bearer token.

## API

All paths below require normal Afe authentication. Cookie mutations require
`X-Afe-CSRF`; foreign Origins are rejected. Responses are `Cache-Control: no-store`.
Base resource path (`B`) is:

```text
/api/actions/argocd/connections/{connectionId}/applications/{application}?appNamespace={namespace}
```

Append suffixes before the query string. Namespace is the Application object's
namespace, not its destination workload namespace. It must exactly match the
current source object. Project, source URL and credential cannot be supplied by
the caller; they are derived from tenant-owned connection and current source.

| Method | Path                               | Behavior                                                                                                                                      |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/actions/argocd/applications` | Applications visible to the linked personal identity; agent-mode limitation is explicit                                                       |
| PUT    | `/api/actions/argocd/consent`      | `{ "enabled": true }` or false; explicit consent for the current personal link                                                                |
| GET    | B                                  | Minimized current application state, source link and typed capabilities with reasons and `paramsSchema`                                       |
| GET    | B + `/resource-actions`            | `resource` query is JSON `{group,kind,namespace,name}`; current source action eligibility                                                     |
| GET    | B + `/diff`                        | Resource identities and difference flags; never manifests or diff values                                                                      |
| POST   | B + `/prepare`                     | `{action,params}`; validates current membership, history, state, RBAC and strict parameters; returns version/context/summary                  |
| POST   | B + `/execute`                     | `{action,params,version,requestId,confirmed:true}`; revalidates and records intent before sending once                                        |
| GET    | B + `/history`                     | Most recent 50 receipts for this actor and exact connection/application/namespace                                                             |
| POST   | B + `/recover`                     | `{requestId,acknowledgeDuplicateRisk:true}`; original actor, current action permission, uncertain request or requested older than two minutes |

For example, prepare `argocd.sync` with `params` containing optional `revision`,
`revisions` (one per source), `resources` (`group,kind,namespace,name`), booleans
`prune,dryRun,force`, and `syncOptions` from the returned schema. Unknown keys
(including `manifests`), arbitrary patches, invalid identities and unknown actions
are rejected. `/execute` uses identical params plus the prepared `version` and a
new UUID. The UI uses these same routes and schemas. Resource actions require selecting a
resource and using `/resource-actions` for the exact source-authorized eligibility;
the application catalog never treats read access as permission to run all actions.

`202/accepted` means only that ArgoCD accepted the request. Source observations
remain the authority for completion. `409` means stale state, invalid state or a
conflicting request; refresh and deliberately prepare again. Permission failures
are `403`; source throttling is `429`; transport/5xx/invalid responses become
`502/unknown` after dispatch. No provider error body is echoed. Mutations never
retry, including refresh's side-effecting upstream GET.

Receipts bind tenant, actor, connection, application/namespace, action, exact
source permission, input digest, version, UUID, state and source status. They
contain no input values or provider response bodies. Receipt replays require
current permission and identical intent. Concurrent requested/unknown mutations
share an application UID lock, across versions. Accepted mutations lock that
source version; a new observed version permits a new deliberate request. Terminate
and refresh have separate locks so they remain available during an uncertain sync.

After a lost browser response, reconfirming preserves the UUID; inspect history
before changing intent. Recovery explicitly acknowledges duplicate risk and does
not dispatch anything. A source change can still race the final source read for
APIs without atomic preconditions (sync, rollback, terminate, actions, deletion).
Sync-policy patch uses the provider's resourceVersion compare-and-swap.

The hourly `argocd-actions.purge` job expires receipts under tenant retention.
This is operational bookkeeping, not a long-term audit log.

## Coordination with logs

Resource context is `connectionId`, Application object `appNamespace`, `application`
and `uid`; `operationId` is the source operation's `startedAt`, not a generated
receipt ID. Source run IDs remain those emitted by the existing capture mapper.
A new sync creates a new source operation; never relabel old logs with the new
request UUID or mix operation attempts. AFE-54 owns log transport/viewing. Refresh
and existing source polling/watch, not the action response, establish completion.
