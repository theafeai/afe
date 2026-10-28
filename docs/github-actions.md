# GitHub delivery operations in Afe (AFE-57)

Open **GitHub Actions** in the navigation, select a connected repository, and
inspect or operate its workflows, runs, jobs, deployments and environments.
Workflow events also link directly to this workspace. The scope is the GitHub
workflow/deployment lifecycle in AFE-57, alongside the existing source observation
connector. Repository code review, issue tracking and organization administration
are separate product areas.

## Setup and permissions

1. Create an Afe managed user and assign GitHub `source + custom`, or `custom`
   with an explicit repository/connection **read** grant. Missing/none denies all.
2. Add exact lowercase repository/action grants in Users, one per line:

   ```text
   repository:acme/app github.dispatch
   repository:acme/app github.rerun
   repository:acme/app github.review_deployment
   ```

   Users includes the complete action catalog. There are no wildcard mutation
   grants; source/read permissions never imply permission to trigger a change.

3. In Profile, link a personal **fine-grained token** restricted to the intended
   repositories, or sign in with GitHub OAuth. Tokens remain encrypted and are
   never returned to the browser. Custom-only users can link an identity too.
4. The user must also have the current GitHub source role and token permissions:

   | Operation                                            | Fine-grained token permissions    | Source role / extra rules                                                  |
   | ---------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
   | Workflow/run/job controls, caches, artifact deletion | Actions: write; Metadata: read    | Repository write                                                           |
   | Artifact / archived log download                     | Actions: read; Metadata: read     | Repository read                                                            |
   | Workflow input schema from YAML                      | Contents: read                    | Dispatch or configuration Afe grant                                        |
   | Create/edit/delete workflow files                    | Contents: write, Workflows: write | Repository write; branch protection applies                                |
   | Deployment create/status/delete                      | Deployments: write                | Repository write; source deletion restrictions apply                       |
   | Pending deployment review                            | Deployments: write                | GitHub's `current_user_can_approve` must permit every selected environment |
   | Environment protection and custom rule configuration | Environments: write               | Repository admin; plan and organization restrictions apply                 |

   GitHub is the final authority on token scopes, organization approval, reviewer
   eligibility and plan-dependent APIs. Afe rechecks repository roles on every
   request, and reports permission or source-state failures without upstream
   bodies. OAuth uses its existing `repo read:user` scopes; **only** checking
   “Allow editing workflow files” before signing in requests the additional
   `workflow` scope. No existing App installation is elevated automatically.

Bootstrap admin/viewer tokens have no personal source identity and cannot perform
these operations. Agents can use a managed user's Afe bearer credential. Hosted
compositions can supply `createAfe({ githubUserId: async (tenantId, principal) =>
managedUserId })`; the server-owned mapping selects a tenant-managed tool account
and policy. Neither the browser nor an agent can supply this mapping in a request.

Repository discovery intersects personal access, tenant policy and the active
connection selection. A repository cannot be operated through an unrelated
installation merely because the personal token can access it. Lists expose
pagination; jobs/log downloads preserve run attempts.

## Supported operations

| Surface                        | Capability / exact grant                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows                      | Discover workflows; inspect state, ref and dispatch schema                                                                                                                                                                                              |
| Manual dispatch                | `github.dispatch`: branch/tag/SHA with string, number, boolean, choice and environment inputs; defaults, required fields and choices validated against YAML at the selected ref                                                                         |
| Workflow state                 | `github.enable`, `github.disable`                                                                                                                                                                                                                       |
| Workflow configuration         | `github.workflow_save`, `github.workflow_delete`: create, edit or remove a YAML file immediately under `.github/workflows`; commit message, branch and current blob SHA; provider CAS and branch protection                                             |
| Runs/jobs/steps                | Run state, conclusion, attempt, job and step progress; inspect earlier attempts without mixing their output                                                                                                                                             |
| Cancellation                   | `github.cancel`, `github.force_cancel`                                                                                                                                                                                                                  |
| Re-running                     | `github.rerun`, `github.rerun_failed`, `github.rerun_job`; optional debug logging; jobs are verified against the selected run and attempt                                                                                                               |
| Approvals                      | `github.approve_run` for fork workflow approval; `github.review_deployment` to approve/reject selected pending environments with a comment and source reviewer restrictions                                                                             |
| Cleanup                        | `github.delete_run`, `github.delete_logs` after completion                                                                                                                                                                                              |
| Deployments                    | List deployments/status history; `github.deployment_create` with ref/environment/task/payload/status checks and explicit auto-merge; `github.deployment_status` with URLs and explicit auto-inactivation; `github.deployment_delete` after inactivation |
| Artifacts                      | Browse source artifact metadata, run association, size and expiry; `github.artifact_download`, `github.artifact_delete`                                                                                                                                 |
| Archived logs                  | `github.logs_download`: completed run logs, scoped to the selected attempt                                                                                                                                                                              |
| Environment protection         | Inspect/create/update/delete environments with `github.environment_save`, `github.environment_delete`; wait timer, reviewer identities and self-review policy                                                                                           |
| Deployment branch/tag rules    | `github.branch_policy_save` (create or update by policy ID), `github.branch_policy_delete`                                                                                                                                                              |
| Custom protection integrations | Inspect available/enabled Apps; `github.protection_rule_enable`, `github.protection_rule_delete`                                                                                                                                                        |
| Actions caches                 | Browse cache keys/refs and sizes; `github.cache_delete`                                                                                                                                                                                                 |
| Request recovery               | Inspect the user's repository-scoped history, acceptance/rejection/uncertainty, source result IDs and explicit recovery                                                                                                                                 |

### Provider boundaries

- **Full live native job output belongs to AFE-52.** The supported GitHub REST
  integration provides job/step progress and completed archives, not a supported
  all-step live stream. Afe does not label completed downloads as live or change
  the parallel runner-capture work. All source/run/job/attempt identifiers remain
  available to that integration.
- A custom deployment protection rule's **decision callback** must come from its
  registered GitHub App. A personal user cannot impersonate it. Afe supports
  configuring those integrations and native human environment reviews; it never
  bypasses an integration's decision or GitHub's reviewer rules.
- GitHub exposes workflow deletion by removing its YAML file through Contents;
  there is no standalone “delete workflow definition” REST operation.
- Workflow YAML reads/edits are limited to 128 KiB to bound parsing and request size.
- Branch protection, required reviewers, protected deployment restrictions,
  expired artifacts, fork approval policy, and plan/organization API restrictions
  remain enforced by GitHub and are shown as unavailable/rejected when applicable.
- Runner fleet provisioning, repository/organization Actions policy and secret
  administration are not deployment lifecycle actions under AFE-57. They are not
  advertised by this workspace or exposed as unrestricted API passthroughs.

## UI and agent API

The UI and API share one operation catalog and strict input schemas. Mutation
preparation checks current source state; confirmation identifies the exact
repository/resource/attempt and review outcome. The server repeats validation
before execution. Source events/polling remain the authority for completion;
no action receipt fabricates a successful deployment event.

- `GET /api/actions/github/resources?page=1` — available connected repositories.
- `GET /api/actions/github/repositories/:owner/:repo?connectionId=…&view=…&page=1`
  — views: `capabilities`, `workflows`, `workflow_file`, `runs`, `run`, `jobs`,
  `pending`, `deployments`, `statuses`, `environments`, `environment`,
  `branch_policies`, `reviewers`, `protection_rules`, `protection_apps`,
  `artifacts`, `caches`, `branches`, `tags`, `history`.
  Capabilities include a JSON Schema for each action’s params and its execution
  method; agents can discover exact input contracts without inspecting source files.
  Resource selectors use `id`, `runId`, `attempt`, `workflowId`, `name`, `ref`
  as appropriate. Capabilities accept `runId`/`workflowId` for state-aware gates.
  Job lists require `runId`; `attempt` selects an explicit attempt.
- `POST …/prepare` — `{connectionId, action, params}` returns `version`,
  `summary` and stable context. See `operationSchemas` in
  `packages/connector-github/src/operations.ts` for each exact parameter shape.
- `POST …` — `{connectionId, action, params, expectedVersion, requestId,
confirmed: true}`. Use the version from preparation and a UUID per deliberate
  intent. Retain the same UUID when replaying after a lost HTTP response.

For example, prepare a debug re-run of one job:

```json
{
  "connectionId": "cab134a3-34ea-44ad-a558-a33bc6b60216",
  "action": "github.rerun_job",
  "params": {
    "runId": 123,
    "attempt": 2,
    "jobId": 456,
    "enableDebugLogging": true
  }
}
```

Run the prepared request only with explicit confirmed intent. The normal session
CSRF/Origin checks or managed-user bearer authentication apply. Unknown parameters
are rejected, arbitrary provider URLs/paths are never accepted, and action grants
are checked again even for a replay.

### Receipts and duplicate recovery

Receipts are written **before** submitting a mutation. States are `requested`,
`accepted`, `rejected`, `unknown`, `released`. Initial acceptance returns 202;
rejection 409; uncertain response 502. A replay returns the stored state after
current authorization, never resubmits it, and cannot reuse an ID for changed
inputs. Check `state`, not just the HTTP code.

Re-run variants share a lock for the same repository/run/attempt across users,
request IDs and the legacy event panel. Deliberately repeatable operations such
as dispatch release their operation lock only after confirmed acceptance. Rejected
requests permit a new intent. Uncertain/in-flight requests block matching repeats.
No upstream mutation is automatically retried, including inside the transport.

`POST …/requests/:requestId/release` with `{connectionId, confirmed: true,
acknowledgeDuplicateRisk: true}` allows the original actor to release an uncertain
receipt after inspecting the source state in Afe. An in-flight request must be at
least two minutes old. The UI explicitly warns that a new request may duplicate
an already accepted operation; the receipt is retained rather than erased.

GitHub offers no atomic expected-attempt precondition for run control, so an
external re-run can race the final check. Contents updates additionally use the
provider's SHA compare-and-swap. A deployment create with explicit auto-merge can
return 202 after merging a branch **without creating a deployment**; that response
is recorded as uncertain and requires inspecting state before another intent.

Operational receipts contain actor, resource, action, input digest and minimal
source result metadata, not input values, YAML, deployment payloads or logs. They
expire with the tenant retention policy; this is not long-term audit storage.

### Downloads

`GET …/download?connectionId=…&kind=artifact&id=…` or
`kind=logs&id=<runId>&attempt=<attempt>` proxies a ZIP attachment. Downloads enforce
source/resource authorization and their exact read-action grant. Signed archive
URLs remain server-side; the destination receives no GitHub bearer token or
cookies. Transfers validate HTTPS, an approved GitHub archive host, public DNS
at lookup and connection, and refuse further redirects. Streaming uses backpressure,
a 10 GiB ceiling, a five-minute total timeout, and at most two transfers per
identity / eight per process. Provider expiry/availability and size-limit errors
are explicit.

The original `GET/POST /api/actions/github/events/:eventId` three-control API
remains compatible and shares receipt locks with the repository workspace.

## References

Provider contracts were checked against GitHub's REST OpenAPI description and
its [Actions REST reference](https://docs.github.com/en/rest/actions),
[Deployments](https://docs.github.com/en/rest/deployments/deployments),
[Environments](https://docs.github.com/en/rest/deployments/environments), and
[Contents](https://docs.github.com/en/rest/repos/contents).
