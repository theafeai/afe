# Terraform CLI lifecycle reports

AFE-34's first supported path is Terraform CLI metadata reporting, on a local
machine or in CI including GitHub Actions. Afe never invokes Terraform. The
user's shell/CI job runs it with the user's existing permissions, then the
reporter sends only operation/result metadata to Afe.

## Connection path decision

| Path                                     | Initial support         | Reason / limit                                                                                                                                             |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Terraform CLI                      | Signed metadata reports | Works with local Docker, no cloud subscription or inbound tunnel                                                                                           |
| Terraform in GitHub Actions              | Same reporter           | Optional repository/commit/GitHub run identifiers link existing events                                                                                     |
| HCP Terraform / Terraform Enterprise API | Deferred                | Has remote run history and can support independent polling/backfill; requires a separate API/permissions/host-safety implementation and account validation |
| Existing uninstrumented CLI runs         | Not observed            | Terraform CLI has no durable read-only run-history API                                                                                                     |

This observes what an authenticated runner reports. A signed successful apply
is **not** verification of current infrastructure, drift, resource contents or
application deployment. The timeline labels provenance as runner-reported.
The event's observation method is `webhook` (a signed inbound report); it is
not a HashiCorp-managed webhook or a Terraform Cloud integration.

## Create and configure

1. Start Afe with server and worker running. In **Connections → Terraform**,
   enter a workspace identifier, optional environment and optional GitHub
   repository (`owner/repo`). Use one connection per workspace/environment.
2. Click **Create reporter connection**. Save its reporter secret immediately:
   it is returned once, like an agent registration secret. Do not send it in
   chat, commit it, or use the Afe admin token for reports.
3. Copy the reporting endpoint. In the runner's secret manager/environment set
   `AFE_TERRAFORM_REPORT_URL` and exactly one of `AFE_TERRAFORM_SECRET` or
   `AFE_TERRAFORM_SECRET_FILE`. The latter is a locally mounted secret file,
   not a Terraform file. GitHub Actions should use an encrypted Actions secret.
4. Use Python 3 and `tools/terraform-report.py` from an Afe checkout. It has
   only standard-library dependencies. Afe itself need not share the Terraform
   directory or Docker socket. The endpoint must be HTTPS, except HTTP on
   localhost/loopback for a local test. No public tunnel is needed when runner
   and Afe are on the same computer.

Workspace/environment/actor identifiers accept letters, digits, `_`, `.` and
`-`, up to 128 characters, starting with a letter or digit. These are metadata
labels; do not put secrets in identifiers. Actor handles may also end in
`[bot]`, which is represented as a bot rather than a human user.

## Report a plan without uploading it

Run from your Terraform working directory. Set `REPORTER` to an absolute path
to the Afe checkout's Python reporter:

```sh
REPORTER=/absolute/path/to/afe/tools/terraform-report.py
RUN_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
python3 "$REPORTER" --run-id "$RUN_ID" --operation plan --phase started

# Terraform is invoked by your shell, not by Afe or the reporter.
set +e
terraform plan -detailed-exitcode
TF_EXIT=$?
set -e

python3 "$REPORTER" --run-id "$RUN_ID" --operation plan --phase completed --exit-code "$TF_EXIT"
# For a detailed plan: 0 = no changes, 2 = changes, other values = failure.
```

Use a fresh UUID for each attempt. Use the same UUID for that attempt's start,
completion and retries. `--operation apply` and `--operation destroy` use the
same sequence around the user's `terraform apply` / `terraform destroy`.
Always capture the **actual** Terraform exit code immediately after the command.
For CI, preserve that exit code even if sending the report fails: report errors
must not turn a Terraform failure into a passing job or overwrite its result.

Optional arguments: `--actor`, `--commit` (full SHA), `--repository`,
`--github-run-id`, `--trigger`. The reporter reads only the known GitHub
metadata variables `GITHUB_ACTOR`, `GITHUB_SHA`, `GITHUB_REPOSITORY`,
`GITHUB_RUN_ID`, `GITHUB_EVENT_NAME` for defaults; it never sends the environment.
If using GitHub metadata, configure the connection's repository to match.
For a pull request, GitHub's SHA may name a merge commit; do not assume it is
the PR head. No actor or commit is guessed from local credentials or file contents.

## GitHub Actions example

After checkout/setup-terraform/init, add a step like this (the reporter must
be available at the given path). Store the endpoint in an Actions variable and
the scoped reporter key in an Actions secret. The runner must be able to reach
Afe; a GitHub-hosted runner cannot call your computer's localhost.

```yaml
- name: Plan and report metadata
  shell: bash
  env:
    AFE_TERRAFORM_REPORT_URL: ${{ vars.AFE_TERRAFORM_REPORT_URL }}
    AFE_TERRAFORM_SECRET: ${{ secrets.AFE_TERRAFORM_SECRET }}
  run: |
    run_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
    python3 tools/terraform-report.py --run-id "$run_id" --operation plan --phase started || echo 'Start report unavailable'
    set +e
    terraform plan -detailed-exitcode
    tf_exit=$?
    set -e
    python3 tools/terraform-report.py --run-id "$run_id" --operation plan --phase completed --exit-code "$tf_exit" || echo 'Completion report unavailable'
    if [ "$tf_exit" -ne 0 ] && [ "$tf_exit" -ne 2 ]; then exit "$tf_exit"; fi
```

## Events, correlation and environment views

| Operation | Started                     | Completed                     |
| --------- | --------------------------- | ----------------------------- |
| Plan      | `terraform.plan.started`    | `terraform.plan.completed`    |
| Apply     | `terraform.apply.started`   | `terraform.apply.completed`   |
| Destroy   | `terraform.destroy.started` | `terraform.destroy.completed` |

Started reports have `in_progress` outcome. Completed exit 0 succeeds; plan
exit 2 also succeeds and sets `data.changesPresent=true`. Apply/destroy exit 2
fails. Conventional interrupt exit codes 130/143 map to `cancelled`; other
nonzero codes fail. An interrupted runner must send its captured exit code;
Afe cannot infer cancellation from silence. A started operation with no
completion stays incomplete. No diagnostic text is ingested.

Filter **Events → Terraform**. Each report names its configured workspace and
environment. Optional commit/repository and GitHub run keys link events to
journeys, where Terraform appears in the **config** stage. Without identifiers,
Git attribution is explicitly unavailable. Service/environment mapping can
use `terraform.workspace`, `terraform.repository` and `terraform.environment`.
These reports do not create an application placement in the live environment
matrix: an infrastructure command's success does not prove an app is live.

## Authentication, durability and health

`POST /agent/terraform/v1/<connection external identity>/reports` accepts a
strict version-1 JSON object. Required fields: `version`, `runId`, `operation`,
`phase`, `sentAt`, `occurredAt`; only completed reports have `exitCode`.
`X-Afe-Signature: sha256=<hex>` is HMAC-SHA256 of the exact raw JSON bytes.
The signing key is scoped to the connection; tenant identity is resolved from
that connection, never accepted from the body. Signed send timestamps must be
within five minutes. A full protocol schema lives in `@afe/connector-terraform`.

Requests are limited to 8 KiB, and each connection can stage 1,000 reports.
A 429 requests backpressure/retry; invalid credentials return 401. Unknown
fields or mismatched repository metadata return 400. Accepted reports and replay
records commit atomically. The worker uses Afe's idempotent event sink before
deleting staged metadata. A one-minute sweep recovers missed enqueue calls.
Duplicate `(connection, run, operation, phase)` returns 200; first valid report
wins, including across retries after an event-store commit. Never reuse a run
UUID for a different attempt. API 202 means durable acceptance, not that the
event is already visible in the UI.

The client retries at most three times with bounded timeouts; it does not
persist an offline queue. If no acknowledgement arrives, retry with the same
run UUID, operation, phase, captured result and attribution. Use `--occurred-at`
with the original ISO timestamp printed on failure to preserve event time on
a delayed retry. There is no independent polling,
backfill or detection of missing reports. Hard termination, an offline runner
or an uninstrumented command can leave missing events. Reports outside event
retention are dropped by the normal sink policy.

Connection health is unknown until a valid report is processed. Last success
means metadata was processed at that time, not that Terraform/provider APIs or
an idle runner are reachable. No periodic probe fabricates liveness and a
failed Terraform command still counts as a successful metadata observation.
Staged metadata is deleted after ingestion, on disconnect, or when the
connection is deleted. Events follow normal retention.

## Rotation and disconnect

Authenticated admin API: `POST /api/connections/terraform/:id/rotate-secret`
returns a new reporter secret once and immediately invalidates the old one.
Update the runner's secret. No rotation grace period is provided initially.
The UI's **Disconnect** revokes the encrypted secret and discards staged reports;
already ingested events remain until retention. A new connection is required
to reconnect. The secret cannot authenticate to any administrative API.

## Minimal real test

Follow [the local Docker example](../../examples/terraform.md). Verify plan,
apply, a changed page, an intentional validation failure and destroy against
the actual CLI, then inspect the metadata events in Afe. Unit/integration
fixtures alone do not establish real Terraform execution or live resource state.
