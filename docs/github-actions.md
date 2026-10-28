# GitHub operations in Afe (AFE-57)

The first action slice supports cancel, re-run all jobs and re-run failed jobs
from a GitHub workflow-run event detail. Open an event from Events or Deployments.
The panel fetches current source state, so controls target the **current** attempt,
even when opened from an older event. Refresh to observe state changes.

## Setup

1. Configure personal GitHub OAuth sign-in (the existing
   `AFE_USER_GITHUB_CLIENT_ID`, `AFE_USER_GITHUB_CLIENT_SECRET` and `AFE_PUBLIC_URL`).
2. Create a managed Afe user. Choose `source + custom` for their GitHub policy.
3. In Users, add exact lowercase repository grants, one per line, for example:

   ```text
   repository:acme/app github.cancel
   repository:acme/app github.rerun
   repository:acme/app github.rerun_failed
   ```

4. The user signs in with GitHub from Profile. Their current GitHub account must
   also have repository write access. GitHub remains the final authority; token
   scopes, organization policy and source state can still reject a request.

Existing observation-only App installations need no permission changes. Source
mode alone never enables mutation. Static admin/viewer tokens have no linked
personal identity; use a managed user's generated Afe credential for agent API
calls. Custom-only policies also need a read grant and an existing account link;
`source + custom` is the recommended onboarding path.

## Agent API

`GET /api/actions/github/events/:eventId` returns source state and capability
entries with `enabled` and a reason. The event must be a primary GitHub workflow
run, belong to the authenticated tenant, and have an active connection.

`POST` to the same path accepts:

```json
{
  "action": "github.rerun_failed",
  "expectedAttempt": 1,
  "requestId": "d385ac85-fd04-4d8f-8737-38e0bc165f41",
  "confirmed": true
}
```

Actions: `github.cancel`, `github.rerun`, `github.rerun_failed`. Send the user's Afe
bearer credential, or the normal session cookie and `X-Afe-CSRF`. Use a new UUID
for each deliberate intent; reuse it when checking/replaying an uncertain request.
Receipts return `requestId`, `state` and `message`: initial acceptance is HTTP 202,
rejection 409, uncertain response 502. A replay returns the stored receipt (200)
after current authorization is checked. A stale attempt/state or duplicate
operation under a different ID returns 409. Duplicate suppression also covers
both re-run variants on the same attempt. Mutations have no automatic retries.
Check `state`, not just HTTP success: accepted means queued at GitHub, not finished.

Operational receipts expire with the tenant retention window. A rejected or
uncertain action remains blocked for that attempt; check source state before
using the original provider UI for recovery. This initial limitation is tracked
under AFE-57.

## Capability coverage and remaining work

| Provider capability                                                                       | Status / owner                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Current run state, run/attempt context                                                    | Implemented in action panel/API                                           |
| Cancel active run                                                                         | Implemented, explicit grant and source write access                       |
| Re-run all / failed jobs                                                                  | Implemented, same permission gates                                        |
| Run/job/step log output                                                                   | Parallel AFE-52; not implemented by action routes                         |
| Workflow discovery / manual dispatch, ref and typed inputs                                | Remaining AFE-57                                                          |
| Per-job re-run, debug logging, force cancel                                               | Remaining AFE-57                                                          |
| Pending deployment review / workflow approval                                             | Remaining AFE-57; preserve source reviewer rules                          |
| Workflow enable/disable                                                                   | Remaining AFE-57                                                          |
| Deployment create/status operations                                                       | Remaining AFE-57                                                          |
| Run/workflow/deployment deletion and cleanup                                              | Remaining AFE-57; consequential confirmation required                     |
| Artifacts and richer run/job/step metadata                                                | Remaining AFE-57; share source context with logs                          |
| Workflow configuration and environment protection administration                          | Inventory/follow-ups under AFE-57; scope and permissions must be explicit |
| Retry/reset of rejected receipts, narrower personal credentials, hosted principal mapping | Remaining AFE-57                                                          |

API references: [cancel](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run),
[re-run](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow),
[failed jobs](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run).
