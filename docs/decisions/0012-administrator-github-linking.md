# ADR 0012: Administrator personal GitHub linking

- Status: Accepted (authorized by AFE-62)
- Date: 2026-11-01
- Amends: ADR 0011, personal-identity setup only

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

New bindings start with GitHub source access and no mutation grants. Linking
permits discovery only within the personal token's repository access and the
active tenant connection selection. Administrators assign exact repository/action
grants in Users to permit operations; all current GitHub roles, token permissions,
provider state checks, confirmation and receipt rules still apply. Administrator
API authority alone never implies GitHub mutation permission. Existing policies,
including `none`, are not replaced during relinking; disabled users stay disabled.

Bindings are keyed by principal ID, independent of bearer versus cookie transport.
A static administrator token's fingerprint identifies its principal, so a token
rotation requires linking again and assigning new operation grants. People sharing
the same administrator credential share the linked GitHub identity; Profile states
this explicitly. A request cannot supply the identity mapping or credential ID.
Tenant/principal lookup and first-time provisioning are serialized and scoped.
