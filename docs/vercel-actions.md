# Operate Vercel from Afe

AFE-58 implements the Vercel delivery workspace at `/vercel`. UI and managed-user
bearer-token agents use the same catalog, scope checks, preparation and execution.
The original observation connection and personal Profile read link never write.
See [ADR 0017](decisions/0017-vercel-delivery-actions.md).

## Capability matrix

“Permission-gated” operations are implemented. They require Source mode, current
personal source access, a selected active connection, separate action-token consent
for this project/operation and Vercel acceptance. Team owner/member/developer roles
are eligible; unknown roles fail closed. Vercel custom roles, fine-grained project
restrictions, token scopes and plan limits remain authoritative at submission.

| Original Vercel capability                                                                       | Status in Afe                                           | Scope/API, constraints or explicit follow-up                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discover projects and deployments                                                                | Supported                                               | Personal account/team intersected with connection selection; project workspace and timestamp-paged deployment lists                                                                              |
| Inspect deployment/build context                                                                 | Supported                                               | Project/connection/deployment IDs, state, environment, commit, source links and current production target; no arbitrary source/config payloads                                                   |
| Deploy connected Git source                                                                      | Permission-gated                                        | `vercel.deploy`: POST `/v13/deployments`, selected project's GitHub repo ID and immutable commit SHA; preview or production                                                                      |
| Redeploy existing deployment                                                                     | Permission-gated                                        | `vercel.redeploy`: POST `/v13/deployments`, original deployment ID, explicit target, `withLatestCommit: false`; terminal builds only                                                             |
| Cancel build                                                                                     | Permission-gated                                        | `vercel.cancel`: PATCH `/v12/deployments/{id}/cancel`; queued/initializing/building only                                                                                                         |
| Promote production build                                                                         | Permission-gated                                        | `vercel.promote`: POST `/v10/projects/{projectId}/promote/{deploymentId}`; READY production build, not already live                                                                              |
| Instant rollback                                                                                 | Permission-gated                                        | `vercel.rollback`: POST `/v1/projects/{projectId}/rollback/{deploymentId}`; READY prior production build marked rollback candidate by Vercel; plan/retention/eligibility still enforced upstream |
| Preview to production                                                                            | Permission-gated via rebuild                            | Redeploy with production target, then observe new deployment; direct preview promotion blocked                                                                                                   |
| Domain/alias assignment to deployment                                                            | Permission-gated                                        | `vercel.alias_assign`: POST `/v2/deployments/{id}/aliases`; owner, READY build, already verified non-redirect domain on this project                                                             |
| Delete deployment                                                                                | Permission-gated                                        | `vercel.delete`: DELETE `/v13/deployments/{id}`; terminal, not production, no aliases; no forced deletion                                                                                        |
| Automatic production domain assignment                                                           | Permission-gated                                        | `vercel.configure`: PATCH `/v9/projects/{id}`; owner, explicit boolean `autoAssignCustomDomains`                                                                                                 |
| Disable/enable preview deployments                                                               | Permission-gated                                        | Same owner-only action; explicit boolean `previewDeploymentsDisabled`; both settings reviewed together                                                                                           |
| Upload source files / prebuilt output                                                            | Deferred: [V1](#v1-source-upload-and-git-providers)     | Supported upstream, needs bounded file transfer and provenance contract                                                                                                                          |
| Deploy GitLab/Bitbucket, branches/tags or latest commit                                          | Deferred: [V1](#v1-source-upload-and-git-providers)     | Provider-specific Git source validation and immutable ref resolution                                                                                                                             |
| Build cache reuse/bypass, custom environments, build settings overrides                          | Deferred: [V2](#v2-build-and-environment-configuration) | Explicit build/region/machine controls and plan-aware validation                                                                                                                                 |
| Build/install commands, framework, root/output directory, runtime/function configuration         | Deferred: [V2](#v2-build-and-environment-configuration) | No generic project patch accepted                                                                                                                                                                |
| Environment variable management                                                                  | Deferred: [V2](#v2-build-and-environment-configuration) | Separate secrets-write design; no values in observation, receipts or logs                                                                                                                        |
| Add/remove/move/verify project domains; alias deletion and redirects                             | Deferred: [V3](#v3-domain-administration)               | DNS ownership, cross-project authorization, expected alias target and certificate status                                                                                                         |
| Rolling releases, canary advancement, abort/complete release                                     | Deferred: [V4](#v4-rolling-releases-and-checks)         | Separate traffic-split state and plan gates                                                                                                                                                      |
| Deployment checks, approvals and protection/bypass settings                                      | Deferred: [V4](#v4-rolling-releases-and-checks)         | Explicit security authorization; never silently bypassed                                                                                                                                         |
| Live build/runtime output and historical logs                                                    | Deferred to AFE-53 under AFE-51                         | Source links provided; action receipts are not log streams                                                                                                                                       |
| Pause/unpause project, project creation/deletion/transfer, Git integration changes, deploy hooks | Deferred: [V5](#v5-project-administration)              | Wider lifecycle/security scope and dedicated authority checks                                                                                                                                    |
| Domains registration/DNS, billing, team/user management, storage and Marketplace resources       | Deferred: [V5](#v5-project-administration)              | Account/platform administration beyond delivery operations                                                                                                                                       |
| Atomic expected-state mutation / exactly-once provider dispatch                                  | Unsupported API                                         | Vercel does not offer a general expected-state/CAS contract for these endpoints; final-check race and ambiguous outcomes remain explicit                                                         |

No deferred capability is represented as an enabled action in discovery.

## Install and authorize

1. Keep observer integration permissions at Read. Do not upgrade the observer.
2. An administrator selects projects on an active Vercel connection and enables
   Linked tool account (Source) for the managed user's Vercel policy.
3. In Profile, the user links a personal read identity in the same team/account.
4. In Vercel deployments, select a project and open **Enable or replace action token**.
   Supply a different personal action token from that same Vercel identity and
   explicitly select operations. Scope it to the one team, set an expiry and use
   the least upstream role. Vercel access tokens cannot be restricted to read-only;
   provider role/resource controls remain essential. Afe cannot introspect all
   token write permissions, so Vercel may still reject an eligible operation.
5. Review the precise project, deployment, environment and parameters in the
   overlay dialog before confirming. Agents must supply structured confirmation.

The encrypted action token is separate from both collection and Profile tokens.
Disable it from the workspace or DELETE the credential endpoint. Revocation is
available even during a source outage or after project deselection. Revoke the
original token in Vercel too. User deletion revokes its stored action credentials.
Disabled users, disconnected connections, unselected projects and policies other
than Source cannot execute or replay. Changing Profile identity invalidates any
action token that no longer identifies the same source user.

## Agent API

Base scope: `/api/actions/vercel/connections/{connectionId}/projects/{projectId}`.
Use a managed user's Afe bearer token; browser sessions also require the usual
CSRF token. Tenant and actor are server-derived. Static admin/viewer tokens do not
supply a personal action identity.

| Method/path                                       | Input/result                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET `/api/actions/vercel/resources`               | Projects visible through your personal account and active connection selection (bounded at 1,000 projects)                |
| GET scope                                         | Workspace, catalog with denial reasons, current settings, deployment page and your last 30 receipts                       |
| GET scope `?deploymentId=dpl_...&until=timestamp` | Selected build context and older deployment page; `next` is the next cursor                                               |
| PUT scope `/credential`                           | `{ "token": "...", "actions": ["vercel.cancel"] }`; explicit per-project consent; encrypted, never returned               |
| DELETE scope `/credential`                        | Revoke your stored project action credential, no source availability needed                                               |
| POST scope `/prepare`                             | Strict `{ "action": "vercel.cancel", "params": { "deploymentId": "dpl_..." } }`; returns fingerprint, context and warning |
| POST scope                                        | Prepared `action`, `params`, `fingerprint`, new UUID `requestId`, `confirmed: true`; returns receipt                      |
| POST scope `/requests/{requestId}/release`        | `{ "acknowledgeDuplicateRisk": true }`; original actor only, uncertain or in-flight for at least two minutes              |

Strict parameter schemas (unknown keys rejected):

- `vercel.deploy`: `{ ref: <40-character GitHub commit SHA>, target: "preview" | "production" }`.
- `vercel.redeploy`: `{ deploymentId, target: "preview" | "production" }`.
- `vercel.cancel`, `vercel.promote`, `vercel.rollback`, `vercel.delete`: `{ deploymentId }`.
- `vercel.alias_assign`: `{ deploymentId, domain: <verified domain on this project> }`.
- `vercel.configure`: `{ autoAssignCustomDomains: boolean, previewDeploymentsDisabled: boolean }`.

A stale fingerprint returns 409 before mutation. Provider read failures return
403/404/429/502 with sanitized messages. A dispatched operation returns 202 with
`accepted`, `rejected` or `unknown`, plus an HTTP status when known and the targeted deployment ID. `accepted`
means the provider accepted the request, never that the deployment completed.
The returned new deployment ID (when available) is a new build identity. Mutation
requests never retry automatically, even on rate limits. Reuse the original UUID
and identical body to retrieve an authorized receipt after a lost response.
A new UUID is deliberate new intent; a pending/uncertain project lock blocks it.
Inspect source state before explicitly releasing an uncertain request.

## Source visibility and logs

Connect actions, events, polling and future log viewers using `connectionId`,
`projectId` and `deploymentId`. Vercel redeployments produce new deployment IDs;
never attach the old build's output to the new build. Vercel does not expose a
GitHub-style numeric run attempt or stable universal build-job identifier here;
leave those absent. Completion continues through existing Vercel webhooks/polling.
Build/runtime native output remains linked to Vercel until AFE-53 supplies the
shared viewer; this change adds no alternate log transport or synthetic events.

## Deferred follow-ups

### V1: Source upload and Git providers

Deliver bounded source/prebuilt upload, immutable branch/tag resolution and
provider-specific GitLab/Bitbucket Git-source schemas with provenance tests.

### V2: Build and environment configuration

Add typed build/cache/custom-environment/runtime controls with plan-aware
validation. Design secrets writes separately before exposing environment values.

### V3: Domain administration

Add domain add/verify/move/delete and alias delete/redirect with current ownership,
expected mapping checks, cross-project authorization and TLS/DNS outcomes.

### V4: Rolling releases and checks

Model release state, percentage advancement, abort/complete, deployment checks,
protection and approvals with appropriate source privileges and race handling.

### V5: Project administration

Inventory and deliver project/account lifecycle controls separately, preserving
personal authority and keeping collection integrations read-only.

## References

[Vercel REST API](https://vercel.com/docs/rest-api),
[promote](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment),
[rollback](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id),
[cancel](https://vercel.com/docs/rest-api/deployments/cancel-a-deployment),
[delete](https://vercel.com/docs/rest-api/deployments/delete-a-deployment).
