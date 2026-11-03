# ADR 0012: Administrator personal GitHub linking

- Status: Accepted (authorized by AFE-62)
- Date: 2026-11-01
- Amends: ADR 0011, personal-identity setup only
- Permission inheritance amended by [ADR 0014](0014-github-source-permissions.md)

> Permission edition boundary superseded by [ADR 0015](0015-open-source-inherited-permissions.md):
> open source allows Source or None only. Legacy Custom and Source + custom are
> blocked pending explicit administrator review. Historical custom-mode behavior
> below no longer applies to the open-source edition.

## Decision

An authenticated administrator can link a personal GitHub token or OAuth account
in Profile without creating another login or changing sessions. Static viewers
cannot use this flow. Managed-user linking remains unchanged. A supplied hosted
`githubUserId` hook remains authoritative, including when it returns no mapping.

The server binds the authenticated principal ID and tenant to a tool-account user
in `github_admin_identities`. It creates that binding only during an explicit
linking action, after GitHub validates a PAT (or when starting configured OAuth).
Profile reads do not provision accounts. The binding reuses the existing encrypted
credentials, account replacement/disconnection, per-user permissions and action
receipts. No generated local login credential is returned or retained. The
associated `github-admin-…` account appears in Users for permission management.

New bindings start in GitHub Source mode, inheriting the linked identity's
supported permissions. Discovery stays within personal token access and active
connection selection. Administrators may add optional action restrictions in Users;
existing custom action allowlists remain intact. All current GitHub roles, token permissions,
provider state checks, confirmation and receipt rules still apply. Administrator
API authority alone never implies GitHub mutation permission. Existing policies,
including `none`, are not replaced during relinking; disabled users stay disabled.

Bindings are keyed by principal ID, independent of bearer versus cookie transport.
A static administrator token's fingerprint identifies its principal, so a token
rotation requires linking again and assigning new operation grants. People sharing
the same administrator credential share the linked GitHub identity; Profile states
this explicitly. A request cannot supply the identity mapping or credential ID.
Tenant/principal lookup and first-time provisioning are serialized and scoped.
