# AFE-81 verification

Chromium screenshots of the production web build, using local API fixtures for an
administrator and a newly added Vercel connection. No real provider credentials or
external provider APIs were used.

For each theme and width, opened new-connection project selection, selected all
projects, and saved. Confirmed automatic navigation to `/connections`, the new
connection in the list, and the success toast without a navigation action. No
page-level horizontal overflow was observed; the connections table scrolls within
its container on mobile.

- `light-1440.png`: light theme, desktop.
- `dark-1440.png`: dark theme, desktop.
- `light-390.png`: light theme, mobile.
- `dark-390.png`: dark theme, mobile.

Validation: all 1,099 tests in 100 files passed against local PostgreSQL 16;
ESLint, Prettier, both TypeScript checks, and the Vite production build passed.
