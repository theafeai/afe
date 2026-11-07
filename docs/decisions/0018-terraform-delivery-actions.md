# ADR 0018: Opt-in personal Terraform delivery operations

- Status: Accepted (authorized by AFE-60 under AFE-56)
- Date: 2026-11-07
- Amends: ADR 0011, R1 integration action exception, ADR 0015's Terraform identity limitation

Afe may operate the explicit HCP Terraform/TFE catalog in
[Terraform operations](../terraform-actions.md). This extends the GitHub-only
action exception to those routes. CLI reporter credentials and observation paths
remain unchanged. The server never invokes Terraform or loads state/plan JSON.

A named user's Source policy, verified personal Terraform user identity, current
resource/action permissions and explicit operation opt-in are required. Missing,
None and legacy custom policies deny access. Static administrator authentication
never supplies source authority. Source reads apply only to selected remote
workspace connections; they grant no access to CLI reports. Credentials stay in
the tenant-bound encrypted repository and are re-read for each operation.

Use the shared prepare/confirm/revalidate/receipt pattern from ADR 0011. Bind exact
run/workspace/policy ownership, reject stale inputs, serialize uncertain intents,
and never automatically retry provider mutations. Operational evidence expires
with tenant retention. The capability matrix explicitly defers remaining provider
operations; unsupported forms cannot be sent as free-form inputs.

Full plan/outputs, task/evaluation overrides and workspace/state administration
remain explicit follow-ups with their own permissions and data-minimization work.
Source links provide visibility meanwhile. AFE-55 owns log transport; plan/apply
and run IDs remain separate, and source polling determines completion.
