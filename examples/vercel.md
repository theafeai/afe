# Vercel: a tiny preview and production deploy

First [copy and publish the demo](README.md). You need a Vercel account and
permission to import the GitHub demo repository. No CLI, framework, packages,
environment variables or paid feature is required by the example itself;
check your account's current usage/plan limits.

## Import and connect

1. In Vercel, choose **Add New → Project**, connect your Git provider and import
   `afe-demo`. Use repository root `.` and framework preset **Other**.
2. Keep `vercel.json`: output directory `site`, empty build/install commands.
   Deploy and open the URL to confirm Version 1.
3. In Afe, open **Connections → Vercel**. Use the OAuth integration when
   configured, or the access-token fallback for a disposable test account.
   Select the Vercel team (or personal account), then **select this project**.
   A connection with no selected projects observes nothing.

Vercel access tokens cannot be restricted to read-only. If using the fallback,
scope/expire the token narrowly and revoke it after testing. Afe only reads with
it. [Connector instructions](../docs/connectors/vercel.md) cover both paths and
optional webhooks. Polling works without a public webhook endpoint or a paid
webhook feature; allow several minutes. Never put the token into the demo repo.

## Preview, then production

If the GitHub guide already merged Version 2, substitute Version 3 below.
From the demo directory:

```sh
git switch main
git pull --ff-only
git switch -c demo/vercel-change
python3 -c 'from pathlib import Path; p=Path("site/index.html"); p.write_text(p.read_text().replace("Version 1", "Version 2"))'
git add site/index.html
git commit -s -m "Change the Vercel demo version"
git push -u origin demo/vercel-change
```

Open a PR. Vercel should create a **Preview** deployment. Open its URL and
check the new version. Merge to main; confirm the **Production** URL then shows
the new version. If the version string was already changed, edit it to a new
number before committing so there is an actual Git change.

In Afe, filter Timeline to **Vercel** and the selected project. Expect deployment
creation and completion/error status, preview versus production target, source
commit, and the actor/trigger metadata Vercel supplies. The Git deployment
should correlate with the same repository/commit used by the GitHub connector.
Map Vercel preview/production targets in **Mapping** to populate the environment
matrix. Preview branch names and production are different environments.

## Troubleshooting and cleanup

- 404: verify Root Directory `.`, Framework Other, Output Directory `site`,
  and empty build/install commands. The page must be in `site/index.html`.
- No preview: check the Git integration's repository access and deployment
  settings; a local Python preview is not a Vercel deployment.
- No Afe events: select the project, check token expiry/team scope, worker
  health and last poll. A protected deployment URL may require login in your
  browser; Afe observes deployment metadata rather than fetching the page.
- Cleanup: disconnect the Vercel connection in Afe, revoke its test token or
  remove the test integration installation as appropriate, then delete the
  Vercel demo project (including deployments) in its Settings. Remove the Git
  demo repository only after other examples no longer need it.

Reference: [Vercel static project configuration](https://vercel.com/docs/project-configuration/vercel-json).
