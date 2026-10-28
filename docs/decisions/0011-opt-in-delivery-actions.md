# ADR 0011: Opt-in delivery actions

- Status: Accepted (product direction authorized by AFE-56/AFE-57)
- Date: 2026-10-28
- Issues: AFE-56, AFE-57

## Decision

Afe supports delivery operations as well as observation. This supersedes R1's
blanket mutation prohibition only for the explicit action catalog and routes in
[GitHub operations](../github-actions.md). Observation clients, App manifests,
installation-token narrowing, webhooks and reconciliation remain read-only.

Every operation requires an exact repository/action Afe grant, resource **read**
access, an active tenant-owned connection that selects that repository, a linked
personal identity and the current GitHub role/permissions. Source/read policy,
custom read grants and bootstrap admin tokens cannot imply mutation permission.
Environment administration requires source admin; human deployment review also
requires GitHub's current per-environment reviewer eligibility. Custom App rule
callbacks cannot be impersonated with a personal identity.

Personal OAuth credentials already use `repo read:user`; only explicit additional
consent before OAuth sign-in adds `workflow` for file editing. A fine-grained token
may instead be linked from Profile, limited to chosen repositories and operations.
Tokens are encrypted through the existing credential repository, re-read at use,
and never returned. A hosted composition may map a trusted principal to its
tenant-managed tool-account user through the server's `githubUserId` hook. The
request cannot supply that mapping or a credential ID.

### Narrow workflow-source exception (R8)

Dispatch input discovery and workflow configuration require reading one YAML file
immediately inside `.github/workflows`, at an explicit ref. They never read
arbitrary source paths. Dispatch-only users receive typed input definitions;
workflow source is shown only with a configuration grant. Create/update/delete
operations require explicit workflow grants and GitHub Contents/Workflows write
permissions; provider branch protection and blob SHA checks still apply. This
explicit, user-requested capability supersedes the blanket “never download file
contents” rule for workflow YAML alone. Source content and submitted deployment
payloads are not stored in events, receipts or logs.

### Confirmation, receipts and recovery

The UI and agent API use one catalog and strict schemas. Mutations are prepared
against current source state, confirmed explicitly, and revalidated before sending.
Receipts are written first and bind tenant, actor, resource, input digest and a
request UUID. Replays require current permission and identical inputs. Matching
uncertain/in-flight operations are locked; all re-run variants share an attempt
lock across both the original event API and repository workspace. Mutation HTTP
requests never retry automatically.

The provider response is acceptance, rejection or uncertainty; it is not deployment
completion. A crash may leave a requested receipt. Rejected requests can use a
new deliberate intent; uncertain ones require the original actor to inspect source
state and explicitly acknowledge duplicate risk before releasing the lock. Wait
at least two minutes before recovering a requested/in-flight receipt. Recovery is
itself retained as `released`. Accepted repeatable dispatch/create operations can
be deliberately repeated with a new UUID. There is no invisible lock reset.

GitHub lacks an atomic expected-attempt precondition for run control, so an external
change can race the final source check. Workflow content updates additionally have
provider SHA compare-and-swap. Deployment creation with auto-merge can return 202
after merging, without creating a deployment; record that as uncertain, not success.

Operational receipts store no input values/YAML/payloads/tokens and expire with the
tenant retention policy. They are not a long-term audit log (ADR 0008). Existing
source events and reconciliation remain the authority for lifecycle completion.

### Artifact and archived-output transfers

Archives are delivered as inert ZIP attachments through a bounded streaming proxy.
GitHub authentication is sent only to the fixed GitHub API origin. Signed storage
locations remain server-side, pass an HTTPS archive-host allowlist plus public-DNS
validation/revalidation, receive no credentials/cookies, and cannot redirect again.
Backpressure, size/time limits and per-identity/global concurrency prevent unbounded
buffering or transfers. This exception permits user-requested artifact/archive
retrieval; the observer never pulls arbitrary source files or container images.

## Coordination with source logs

AFE-51/52 own live capture, streaming, forwarding, buffering and the log viewer.
Actions are separate; shared context is `connectionId`, `repository`, `runId`,
`runAttempt` and `jobId`. Re-running never relabels a previous attempt's output.
GitHub REST archived downloads and job/step progress are not advertised as live
native output. The separate capture feasibility work is preserved.
