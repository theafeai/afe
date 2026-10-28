## Summary

<!-- What does this change and why? Link the issue (e.g. AFE-123). -->

## Testing

<!-- How was this verified? -->

## Checklist

- [ ] Commits are signed off (`git commit -s`, see CONTRIBUTING.md)
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] Docs / ADRs updated if behaviour or architecture changed
- [ ] UI changes follow `docs/design-system.md`; light and dark screenshots attached (delete if no UI change)

## New or changed integration — security checklist

<!-- Required when this PR adds or changes a connector, webhook receiver, agent,
alert sink or any other outbound/inbound integration. Otherwise delete this
section. Rules: docs/security/rules.md -->

- [ ] **Least privilege (R1):** only read-only scopes/permissions/roles are requested; each one is listed with its justification in the package README
- [ ] **Read-only calls (R1):** the connector only issues read requests (`GET` / read-only queries), and a test asserts it
- [ ] **Credentials (R2):** stored only via the `@afe/db` credentials repository (encrypted, per tenant), passed around as `Secret`, read at use time so rotation/revocation take effect
- [ ] **Webhooks (R3):** signature verified over the raw body with the `@afe/core/security` helpers before parsing; missing/invalid signatures rejected with 401
- [ ] **Replays (R3):** `recordDelivery` / `ReplayGuard` used with the provider's delivery id; signed timestamps checked with `isTimestampFresh` where available
- [ ] **No secrets in logs (R4):** no tokens, signatures, auth headers or raw bodies logged; tests check captured logs
- [ ] **Tenant isolation (R5):** every new table has `tenant_id` in its keys; every query filters by `tenantId`; tenant comes from auth/verified mapping, never from request input; a wrong-tenant test exists
- [ ] **Outbound safety (R6):** user-supplied URLs pass `validateOutboundUrl` and the HTTP client uses `createSafeLookup`; no automatic cross-host redirects; timeouts and size limits set
- [ ] **TLS (R7):** verification stays on; custom CAs are configured instead of disabling it
- [ ] **Data minimisation (R8):** no source code, file contents, secret or env var values stored; new stored fields added to `docs/security/data-inventory.md`
- [ ] **Tests (R9):** fixtures/fakes only; valid/invalid signature, replay, wrong tenant and log-redaction cases covered
