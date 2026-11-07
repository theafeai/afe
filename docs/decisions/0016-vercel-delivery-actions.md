# ADR 0016: Opt-in personal Vercel delivery operations

- Status: Accepted (authorized by AFE-58 under AFE-56)
- Date: 2026-11-07
- Amends: ADR 0005, ADR 0011 and security R1 for the explicit Vercel catalog only

Afe exposes Vercel delivery operations through one scoped API used by the web UI
and authenticated agents. The capability inventory and deferred work are in
[the Vercel operations matrix](../vercel-actions.md). Observation installations,
OAuth permissions, `VercelClient`, capture and reconciliation remain read-only.

A managed user must have Source mode, a personal Vercel read link, an active
connection selecting the project, and a matching personal/team scope. A separate
personal action credential requires explicit consent to individual catalog
operations on one connection/project. This narrows inherited source authority;
it is not a custom permission mode or an administrator-granted entitlement.
Bootstrap administrator tokens have no Vercel action authority.

Action credentials must identify the same Vercel user as the read link. Current
project access and team role are checked before preparation, execution and receipt
replay. Unknown/read-only/billing/contributor roles fail closed. Owner, member and
developer roles are eligible for delivery; domain assignment and delivery-setting
changes conservatively require owner. Vercel enforces finer project roles, token
scopes, plan restrictions and deployment eligibility on each mutation. Afe cannot
reliably predict all token-level write scopes from a successful read request;
capability eligibility is not a promise of provider acceptance.

Deploy-from-Git takes an immutable GitHub commit SHA and the selected project's
own repository ID. Arbitrary files, Git tokens, environment values, project IDs,
URLs and security settings are never accepted as mutation payloads. Alias
assignment is restricted to a verified, non-redirect domain already attached to
the same project. Deployments serving production or having aliases cannot be
deleted. Preview promotion is blocked; rebuild for production first.

Preparation fingerprints current project settings, Git link, production target,
selected build state, rollback eligibility, domains and aliases. Execution
revalidates them. Vercel provides no atomic expected-state precondition for these
operations; a source change can race the final check. Source role checks are not
an assertion of deployment success.

Receipts bind tenant, actor, connection, project, intent digest and UUID before a
mutation. One in-flight or uncertain request locks a project across connections.
Replay requires current authorization and identical intent. 4xx rejections
(except ambiguous 408), including rate limits, may be deliberately resubmitted
with a new UUID after inspection; redirects, network errors, 5xx and malformed
success bodies remain uncertain. Requests are never automatically retried.
Accepted operations can be deliberately repeated with a new UUID. The original
actor can release an uncertain request after acknowledging duplicate risk;
in-flight requests require two minutes. Receipts expire under tenant retention,
including tenants with no observed events, and are not a long-term audit log.

Completion remains owned by source events/polling. A new deployment gets a new
ID, never the old build's log identity. AFE-51/AFE-53 own log transport, buffering,
redaction and viewers separately.
