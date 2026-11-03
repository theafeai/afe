# AFE-83 mapping lists

The mapping page with representative service descriptions, environment kinds, and
long identifiers, captured in Chromium at 1440px and 390px in light and dark mode.
API responses use local fixtures; no live account data is shown.

Browser checks passed for viewport/row overflow, service and environment creation
and deletion, environment reordering, and disabled boundary controls. No browser
runtime errors were observed.

Validation: lint, TypeScript, and the mapping/design-system tests (13 tests) pass.
The full suite could not complete successfully: PostgreSQL is unavailable at
localhost:5432 (confirmed with ECONNREFUSED outside the network sandbox).
