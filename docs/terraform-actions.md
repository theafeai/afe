# Terraform delivery operations (AFE-60)

Afe's **Terraform** workspace operates HCP Terraform and Terraform Enterprise
remote/agent runs. CLI reporters remain metadata-only. Afe never invokes Terraform
or reads a working directory, configuration archive, state file or plan JSON.
This uses the shared delivery-action pattern established by AFE-57 / ADR 0011.

## Install and authorize

1. An administrator opens **Terraform → Add remote workspace**. Enter the server
   origin (default `https://app.terraform.io`), organization slug and exact `ws-…`
   workspace ID. This stores a selection, without a collection/write credential.
   Workspace existence and organization membership are verified with each user's
   personal token, rather than with the administrator's observation authority.
2. Create a **named Afe user** in Users, set Terraform to **Linked tool account**
   (Source), and give that user its Afe login. Static administrator/viewer tokens
   cannot operate Terraform or impersonate a Terraform identity. Legacy Custom
   modes fail closed, as for other tools (ADR 0015).
3. That user opens Profile, enters the remote connection UUID and a **personal
   Terraform user API token**. Afe calls `/api/v2/account/details` and requires a
   `users` identity. Team and organization tokens are not supported. The link is
   bound to the selected server and verified source user ID; only one Terraform
   server identity can be linked per Afe user at a time.
4. Leave **Enable delivery operations** unchecked for read-only access. Check it
   explicitly to enable operations within the user's current source permissions.
   Limit workspace membership/teams upstream to the least permissions required:
   read runs/plans for visibility, queue plans for planning, apply for applying,
   cancel/discard for run control, policy override only for designated reviewers,
   and workspace lock/unlock only for operators. Do not use an organization owner
   or broad team token as a collection credential. Afe never borrows another
   user's credentials. Relinking replaces the token and resets the opt-in to the
   submitted value (default false). Unlinking revokes the encrypted credential.
5. Select the workspace in Terraform. Review an operation's exact target, then
   confirm in the dialog. Source-state polling every 15 seconds while the selected
   workspace is open observes completion. Acceptance never creates a deployment
   event or proves infrastructure is live.

The API rechecks active tenant-owned connection, enabled user, Source policy,
credential, provider identity, workspace organization, run workspace, and exact
provider action permission. It also checks run action flags and policy-check
ownership/state. Read access never enables a write; even a writable personal token
remains read-only in Afe until explicitly opted in. Terraform Source reads expose
only selected remote workspace connections, never same-named CLI reporter data.

For TFE, allow network access to the configured origin. HTTPS certificate checks
stay enabled. Private addresses require `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`;
use `NODE_EXTRA_CA_CERTS` for a private CA. HTTP additionally requires
`AFE_ALLOW_INSECURE_HTTP_TARGETS=true` and is for local labs only. Origins cannot
include credentials, paths, queries or fragments. Every request revalidates DNS
and uses `createSafeLookup` at connect time. Redirects are not followed. The client
has a 5-second connection deadline, 15-second total deadline and 2 MiB response
limit. It never retries mutations. TFE versions that omit required source flags
fail closed; provider acceptance remains authoritative.

## Provider capability matrix

The matrix inventories deployment operations; “deferred” means no Afe mutation
route or implicit fallback exists. These follow-ups belong to this provider's
remaining parity work, not to the separate live-log transport. API shapes were
checked against HashiCorp's [go-tfe model](https://github.com/hashicorp/go-tfe/tree/ae6fb1776229e2e27f57dab693cc313e68c34a52/v2/api).
No live HCP/TFE account was available for acceptance testing; integration tests
use a local provider implementing those contracts.

| Operation                                                                                      | HCP Terraform / TFE API disposition          | Permission / limit or explicit follow-up                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue speculative plan                                                                         | Supported, permission-gated                  | `terraform.plan`; workspace `can-queue-run`; remote/agent execution; not locked                                                                                                                                             |
| Queue normal plan/apply run                                                                    | Supported, permission-gated                  | `terraform.run`; `can-queue-run`; `auto-apply:false`, `is-destroy:false`; later apply confirmation required                                                                                                                 |
| Apply / confirm pending run                                                                    | Supported, permission-gated                  | `terraform.apply`; run `can-apply` and `is-confirmable`                                                                                                                                                                     |
| Discard run                                                                                    | Supported, permission-gated                  | `terraform.discard`; `can-discard` and `is-discardable`                                                                                                                                                                     |
| Cancel / force-cancel run                                                                      | Supported, permission-gated                  | `terraform.cancel` / `terraform.force_cancel`; corresponding source permissions and availability flags; source enforces force-cancel delay                                                                                  |
| Sentinel soft policy-check override                                                            | Supported, permission-gated                  | `terraform.policy_override`; run `can-override-policy-check`, check `can-override` and `is-overridable`, soft failure / `policy_override`; hard failures cannot be overridden                                               |
| Workspace lock / ordinary unlock                                                               | Supported, permission-gated                  | `terraform.lock` / `terraform.unlock`; `can-lock` / `can-unlock` and current lock state; never force-unlock                                                                                                                 |
| Run status, source links, plan/apply IDs                                                       | Supported                                    | Tenant/workspace scoped, paginated recent runs, fresh source reads                                                                                                                                                          |
| Plan addition/change/destruction counts                                                        | Supported read                               | Bound run → plan ID → plan metadata; denied/unavailable plans show unavailable, never zero                                                                                                                                  |
| Full plan, resource diffs, output visibility                                                   | Source links supported; value proxy deferred | **TF-sensitive-reads:** design explicit sensitive-output permissions, masking and bounded transient rendering; do not fetch plan JSON or state/output values now                                                            |
| Task-stage override, policy-evaluation/OPA override, task approval/retry                       | Explicit deferred follow-up                  | **TF-task-controls:** version-aware task-stage/evaluation discovery, per-stage task vs policy permissions, exact run/stage binding and confirmation. Use Terraform source UI meanwhile; Sentinel checks are a different API |
| Force-execute queued run                                                                       | Explicit deferred follow-up                  | **TF-queue-controls:** validate queue ordering and current-run replacement; stronger confirmation                                                                                                                           |
| Destroy, refresh-only, targeted/replacement/import runs, saved-plan apply                      | Explicit deferred follow-up                  | **TF-specialized-runs:** typed options and destructive/target-specific confirmation, permissions and tests; no free-form variables or addresses accepted now                                                                |
| Upload/select configuration versions, arbitrary run variables, workspace variable sets         | Explicit deferred follow-up                  | **TF-configuration:** credential/data-minimization design and exact configuration identity; current queue uses provider's current configuration                                                                             |
| Change auto-apply, execution mode, Terraform version, VCS/settings/run triggers/tasks/policies | Explicit deferred follow-up                  | **TF-workspace-admin:** separate administrator catalog with compare-and-swap/state validation; no configuration writes now                                                                                                  |
| Force-unlock, delete workspace/state versions, state rollback/import                           | Explicit deferred follow-up                  | **TF-state-admin:** destructive-state safeguards and recovery design; no state read/write endpoint now                                                                                                                      |
| Cost estimates, comments, configuration downloads, artifacts                                   | Explicit deferred follow-up                  | **TF-detail-reads:** scoped bounded metadata/transfer design; use source UI now                                                                                                                                             |
| Local CLI/manual ingestion operations                                                          | Unsupported API                              | No durable CLI run-control API. Signed reports neither grant remote permissions nor allow executing local commands; operate the original CLI/CI job directly                                                                |
| Live plan/apply stdout                                                                         | Separate AFE-55 / AFE-51                     | No log viewer, download, transport, buffering or ingestion added here                                                                                                                                                       |

## Agent and UI API

Both clients use the same catalog (`TERRAFORM_OPERATIONS`), strict input validator,
capability calculation, prepare/execute path and receipts. Bearer authentication
uses the named Afe user's token; cookie sessions also require the existing CSRF
header. A request cannot provide a tenant, user ID, provider token, credential ID,
server URL, arbitrary API path or workspace override to the operations API.

| Route                                                                               | Contract                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/connections/terraform/remote`                                            | Administrator only; `{serverUrl?, organization, workspaceId}`; returns selected connection                                                             |
| `POST /api/profile/tools/terraform/token`                                           | Named user in Source mode; `{token, connectionId, actionsEnabled?:false}`; write-only credential                                                       |
| `DELETE /api/profile/tools/terraform`                                               | Unlink and revoke personal credential                                                                                                                  |
| `GET /api/actions/terraform/resources`                                              | Discover accessible, tenant-selected remote workspaces with the linked user token                                                                      |
| `GET /api/actions/terraform/connections/:connectionId?page=1`                       | Workspace/run/policy metadata and scoped capabilities; 20 runs per page with `nextPage`                                                                |
| `POST /api/actions/terraform/connections/:connectionId/prepare`                     | Strict operation below; returns `version`, target `summary`, `sourceUrl`; no mutation                                                                  |
| `POST /api/actions/terraform/connections/:connectionId/execute`                     | `{operation, version, requestId, confirmed:true}`; UUID bound to actor, connection, action, inputs and version                                         |
| `GET /api/actions/terraform/connections/:connectionId/requests`                     | Latest 30 receipts for the current actor and connection                                                                                                |
| `POST /api/actions/terraform/connections/:connectionId/requests/:requestId/recover` | `{confirmed:true, acknowledgeDuplicateRisk:true}`; original actor only; unknown, or requested for at least two minutes; releases lock without retrying |

Operation examples (all other keys are rejected):

```json
{"action":"terraform.plan"}
{"action":"terraform.apply","runId":"run-example"}
{"action":"terraform.policy_override","runId":"run-example","policyCheckId":"polchk-example"}
```

Prepare is bound to the exact current source state, credential and inputs. Execution
revalidates after acquiring a database lock. Replays require current identity,
policy, opt-in and action permission and identical inputs; they never POST again.
Resource locks serialize in-flight/uncertain requests across actors. Accepted
non-queue operations also retain a version lock; deliberately repeatable queue
operations may use a new UUID after acceptance. An external source change can
still race the final check: Terraform offers no atomic expected-version token
for run actions. Terraform's own state machine is the final authority.

A receipt is `requested`, `accepted`, `rejected`, `unknown` or `released`. A 202 is
acceptance, not deployment completion. Explicit provider 4xx responses are rejected
(429 preserves numeric Retry-After); timeouts/disconnects/5xx/redirects and malformed
queue results are uncertain. After a transport failure, inspect your request
history and source state instead of submitting a new intent. A crash can leave a
requested receipt; recovery never runs automatically. Retrying the _same_ intent
UUID reads its receipt after authorization. Recovery requires an explicit duplicate
risk acknowledgement and never cancels or retries the original source operation.

Receipts store only IDs, action, hashes, timestamps, sanitized state/HTTP status
and optional created run ID. No source body, variables, token, output, plan, log
or signed log URL is persisted or logged. The hourly `terraform-actions.purge`
job applies the tenant event retention cutoff. These are operational receipts,
not a long-term audit log (ADR 0008).

## Coordination with AFE-55

Shared context is tenant + connection ID + source workspace ID + immutable run ID,
with source plan/apply IDs exposed separately. A new queued run receives a new run
ID. Existing run output is never reassigned or labelled as a new attempt. No CLI
report UUID is treated as an HCP run ID. Actions do not infer completion from a
request receipt or a closed log stream; current source events/polling own lifecycle
truth. This PR adds on-demand source polling only, not background ingestion,
remote-run backfill, live logs or infrastructure verification.
