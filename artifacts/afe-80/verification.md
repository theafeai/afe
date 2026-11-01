# AFE-80 verification

The GitHub Actions page discovers all accessible repositories through the existing paginated `/api/actions/github/resources` endpoint. Users can search and select any result, pin repositories as directly clickable tabs, and return to their saved selection and pins. Repository keys include both the connection ID and repository name; preferences are scoped to the Afe tenant and principal. Fresh discovery controls which saved repositories can be shown or selected.

| Boundary      | Evidence                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser       | Chromium exercised 104 repositories, case-insensitive search, pinning, dropdown selection, reload persistence, keyboard opening and Escape focus return. No page errors or document overflow at 1440px or 390px, in light and dark themes. |
| Client → API  | Component tests retain paginated discovery (including empty intermediate pages), connection-scoped workspace requests, deep-link access validation and isolation from late responses after switching.                                      |
| API → data    | Discovery and server authorization are unchanged. All 61 GitHub operations server tests passed against local provider fakes and PostgreSQL.                                                                                                |
| Response → UI | Component tests cover no access, discovery loading/error/retry, search/no results, pin/unpin, persistence, revoked access, malformed preferences and unavailable storage.                                                                  |
| Design system | Shared components, token-only CSS and design-system tests; inspected desktop/mobile screenshots in both themes.                                                                                                                            |

Browser checks use local API fixtures rather than a live GitHub account. The dropdown uses a native disclosure with normal keyboard navigation between search, selection and pin buttons. Results have a bounded vertical scroll area, and pinned tabs scroll horizontally.

Validation: ESLint, Prettier, both TypeScript checks, the web production build, 33 focused UI/design-system tests and 61 GitHub operations server tests passed. The full regression suite passed all 100 files and 1,095 tests.

Screenshots: [light desktop](light-1440.png), [light mobile](light-390.png), [dark desktop](dark-1440.png), [dark mobile](dark-390.png).

Environment: database checks use a disposable PostgreSQL 16 container and `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/afe_test`. The default `localhost` address stalled in this cloud runtime; explicit IPv4 completed the server checks. Installed tool binaries were invoked directly because the pnpm launcher attempted to initialize its store under an unavailable home directory.
