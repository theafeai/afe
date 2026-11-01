# AFE-79 verification

Repository discovery flows from the GitHub Actions page through the existing `/api/actions/github/resources` endpoint. That endpoint filters the personal GitHub repository list by active Afe connections and user policy. The page fetches all resource pages, selects an accessible repository, and loads its workspace with the connection ID and repository as its React key.

| Boundary             | Evidence                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI renders           | Chromium screenshots at 1440px and 390px in light and dark themes; 35 repository choices; no document overflow or page errors.                                |
| Client → API         | Component tests cover every resource page, including an empty filtered page with more results. Requests retain the existing connection/repository scope.      |
| API → data           | Existing discovery endpoint and authorization remain unchanged. Server regression tests use local GitHub fakes and PostgreSQL.                                |
| Response → UI        | Component tests cover default selection, switching, restored selection, revoked access, inaccessible deep links, empty results, discovery failures and retry. |
| Repository isolation | A deferred response from the previous repository cannot replace the new workspace. Workflow IDs may overlap.                                                  |

Browser checks use local API fixtures, not a live personal GitHub account. The saved selection is scoped by Afe tenant and principal and checked against fresh discovery results on entry.

Screenshots: [light desktop](light-1440.png), [light mobile](light-390.png), [dark desktop](dark-1440.png), [dark mobile](dark-390.png).

Validation: `pnpm lint`, `pnpm typecheck`, and `pnpm test` passed. The full suite passed 99 files and 1,052 tests. Browser checks passed for 35 repository choices, switching, reload persistence, light/dark themes, desktop/mobile layouts, console errors and document overflow.
