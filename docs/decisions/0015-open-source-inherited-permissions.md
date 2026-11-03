# ADR 0015: Inherited permissions in open source; custom permissions planned for cloud

- Status: Accepted (authorized by AFE-84)
- Date: 2026-11-03
- Amends: ADRs 0011, 0012 (administrator GitHub linking), and 0014

## Decision

Open-source Afe supports `source` as its only permission-granting mode. `none`
and missing policies disable access. Resource visibility and supported actions
require a linked personal identity and current source authorization. Provider
roles, scopes, repository selection, tenant boundaries, confirmation, receipt
locks and replay authorization continue to apply. GitHub deny-only restrictions
remain a narrowing safety control, not an alternative permission-granting mode.
Bootstrap/static-token observation behavior is unchanged; these credentials do
not supply personal GitHub operation authority.

The UI exposes only No access and Linked tool account. Both the API and shared
policy writer reject custom modes and nonempty custom grants. No edition flag
or dormant custom-grant evaluator enables cloud features in this repository.
Legacy mode names remain in the storage/read type so administrators can inspect
old configurations. Authorization denies the entirety of `custom` and
`source + custom`, even with valid source credentials; it never falls back to
Source. Existing Source rows ignore stale custom entries and retain deny rules.
All tools, reads, linking flows and GitHub operations use this boundary.

No automatic rewrite is safe: Source can be broader than a legacy allowlist.
Rows and credentials are left intact until explicit review. The
[upgrade procedure](../user-management.md#upgrade-from-custom-policies) requires
an administrator to compare source authority, optionally narrow it upstream,
and explicitly save Source or None with empty custom grants. Omitted GitHub
deny rules are preserved. Saving removes obsolete grants; operators should
back them up first when needed. Disabled accounts remain disabled. This changes
server authorization immediately on upgrade, without waiting for a migration.

Terraform reports lack a verifiable personal source identity; managed users
receive no Terraform access. A custom grant is not a fallback. Existing
administrator observation remains available.

## Cloud-only follow-up scope

Afe-managed custom resource and action permissions are planned for Afe Cloud in
the separate private product (ADR 0002). This decision does not ship that feature
or promise an availability date. Before implementation:

- Define tenant administrators, permission subjects/groups, resource selectors,
  read versus action permissions, deny precedence, and how custom/source policies
  combine. Decide which grants may rely on collection credentials; never infer
  mutation authority from observer tokens.
- Design an explicit authorization extension across event SQL filtering, derived
  views, connection visibility, linking, capabilities, execution and receipt replay.
  Hosted authentication hooks alone must not enable custom permissions.
- Add cloud entitlement checks at every write and enforcement boundary, with
  tenant isolation and no client-controlled edition switch.
- Design administration UI/API, validation, revocation behavior and observability
  in the private product. Preserve confirmation, source authorization and credential
  handling for actions.
- Provide reviewed import/preview of retained legacy data, explicit acceptance of
  access changes, safe downgrade behavior, backups and rollback guidance. Never
  activate retained grants merely by changing edition.
- Test grants, revocations, denies, source outages, concurrency, replay, disabled
  users, cross-tenant access and edition transitions end to end.

Source changes remain authoritative for inherited access. A verified personal
Terraform resolver is separate work; custom workspace grants do not implement it.
