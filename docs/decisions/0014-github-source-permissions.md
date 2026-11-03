# ADR 0014: Inherit GitHub permissions in Source mode

- Status: Accepted (authorized by AFE-77)
- Date: 2026-11-01
- Amends: ADR 0011 and ADR 0012 administrator GitHub linking

> Permission edition boundary superseded by [ADR 0015](0015-open-source-inherited-permissions.md):
> open source allows Source or None only. Legacy Custom and Source + custom are
> blocked pending explicit administrator review. Historical custom-mode behavior
> below no longer applies to the open-source edition.

## Decision

GitHub **Source** mode inherits all supported operations from the linked personal
identity, without requiring duplicate Afe action grants. The server checks current
repository access/role using that credential on each request. GitHub remains the
final authority on token scopes, SSO, organization restrictions, branch protection,
reviewer eligibility and operation-specific permissions. Capability responses are
predictions; they do not guarantee that GitHub will accept the operation.

Administrators can optionally restrict exact repository/actions through `denied`
entries in a GitHub tool policy. These restrictions take precedence in every mode,
including on receipt replay, workflow-source reads, log reads and archive downloads.
They never expand provider access. Resource discovery and event visibility remain
controlled by existing read policies; action restrictions do not hide event data.

| Mode                  | GitHub operations                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------- |
| none / missing policy | Denied, even with a linked credential                                                    |
| source                | Inherited, except explicitly restricted actions                                          |
| custom                | Explicit action allowlist plus explicit resource read access, minus restrictions         |
| source + custom       | Source discovery/read access plus existing explicit action allowlist, minus restrictions |

Custom and Source + custom preserve their existing GitHub action semantics for
compatibility. This does not change other tools' Source + custom behavior.
Admins wanting inheritance for an existing allowlisted account explicitly switch
it to Source; saving the mode does not discard its optional restrictions. A Source
policy's custom entries are retained but ignored. Switching back to an allowlist
mode restores their effect.

## Upgrade and administration

The forward-only migration adds an empty `denied_grants` array; it does not rewrite
modes or custom grants. Existing Source policies intentionally gain inherited
operations as requested by AFE-77. New administrator GitHub links start in Source
mode. Existing custom allowlists, disabled policies/users, tenant bindings and
credential state remain unchanged. Relinking never replaces a policy.

An admin can set restrictions in Users or use the existing admin permission API:

```json
{
  "mode": "source",
  "custom": [],
  "denied": [{ "resource": "repository:acme/app", "action": "github.delete_run" }]
}
```

Only supported GitHub action names on exact lowercase repository resources are
accepted. No wildcard or implicit deny is created for an unlisted action. Omitting
`denied` from a policy update preserves existing restrictions (older clients must
not erase them); supplying `[]` explicitly clears them. Policy data remains
scoped to tenant, user and tool.

## Preserved boundaries

A linked identity and current credential are always required. Tenant ownership,
active connection/repository selection, role requirements, source-state checks,
reviewer restrictions, confirmation, receipt locks, replay authorization and
non-retried mutations still apply. Afe administrator authentication alone never
supplies GitHub authority. Observer App tokens remain read-only. No permissions
are inferred from the App installation or from a different user's token.
