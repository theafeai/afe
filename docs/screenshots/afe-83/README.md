# AFE-83 mapping lists

The mapping page with **100 services and 40 environments**, captured in Chromium
at 1440px and 390px in light and dark mode. API responses use local fixtures;
no live account data is shown.

Each collection has independent search across names, identifiers and details,
five-item pagination, result counts, and a bounded scrolling list. Creation forms
expand on demand. Environment ordering remains global across pages and filters.
Long identifiers wrap without overlapping controls.

Browser checks passed for viewport/row overflow, pagination and search, service
and environment creation/deletion, environment reordering, and disabled boundary
controls. No browser runtime errors were observed.

Validation: lint, TypeScript, and mapping/design-system tests (19 tests) pass.
Regression coverage includes deleting the final page, search reset/no matches,
description/kind search, independent lists and reordering filtered results.
The full suite remains blocked by unavailable PostgreSQL at localhost:5432
(ECONNREFUSED confirmed outside the network sandbox).

Pagination is client-side: this bounds rendered rows and page height, but the
existing mapping API still loads the complete collection.
