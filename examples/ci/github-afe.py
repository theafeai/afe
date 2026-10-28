"""Verify two real Pages deployments against an already connected Afe instance.

This does not create an App, forge webhooks, seed events, or deploy anything.
Only whitelisted source/event evidence is written to github-evidence/.
"""

import argparse
import base64
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token=None):
    headers = {"Accept": "application/json", "User-Agent": "afe-demo-acceptance"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Do not print response bodies, request headers or secrets.
        raise RuntimeError(f"HTTP {error.code}: {urllib.parse.urlsplit(url).path}") from None


def require(value, message):
    if not value:
        raise RuntimeError(message)


def source_run(repo, run_id, version):
    api = "https://api.github.com/repos/" + repo
    run = request(f"{api}/actions/runs/{run_id}")
    require(run.get("repository", {}).get("full_name", "").lower() == repo.lower(),
            "Run belongs to a different repository")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            f"Version {version} workflow has not completed successfully")
    require(run.get("head_branch") == "main" and run.get("path") == ".github/workflows/pages.yml",
            "Expected the standalone Pages workflow on main")
    sha = run["head_sha"]
    page = request(f"{api}/contents/site/index.html?ref={sha}")
    require(re.search(rf'\bid="version"[^>]*>\s*Version {version}\s*<',
                      base64.b64decode(page["content"]).decode()),
            f"Source commit does not contain Version {version}")
    query = urllib.parse.urlencode({"sha": sha, "environment": "github-pages", "per_page": 100})
    deployments = request(f"{api}/deployments?{query}")
    for deployment in deployments:
        statuses = request(f"{api}/deployments/{deployment['id']}/statuses?per_page=100")
        for status in statuses:
            # GitHub links the originating Actions run through the status log URL.
            linked = any(re.search(rf"/actions/runs/{run_id}(?:/|$)", status.get(key) or "")
                         for key in ("log_url", "target_url"))
            if status.get("state") == "success" and linked:
                return {"version": version, "runId": run_id, "commit": sha,
                        "runUrl": run["html_url"], "trigger": run["event"],
                        "deploymentId": deployment["id"], "statusId": status["id"]}
    raise RuntimeError(f"No successful github-pages deployment linked to Version {version} run")


def matching_events(rows, repo, connection, run):
    matches = {}
    for row in rows:
        event = row["event"]
        correlation = event.get("correlation", {})
        if (event.get("source") != "github" or event.get("connectionId") != connection
                or event.get("target", {}).get("repository", "").lower() != repo.lower()
                or run["commit"] not in correlation.get("commitShas", [])
                or event.get("outcome") != "succeeded"):
            continue
        action = event["action"]
        if (action == "workflow_run.completed"
                and f"github:{run['runId']}" in (correlation.get("runIds") or [])):
            matches["workflow"] = row
        if (action == "deployment.status_updated"
                and f"github:{run['deploymentId']}" in (correlation.get("deploymentIds") or [])
                and event.get("target", {}).get("environment") == "github-pages"
                and event.get("data", {}).get("status", {}).get("id") == run["statusId"]):
            matches["deployment"] = row
    return matches if len(matches) == 2 else None


def collect_events(base, token, repo, connection, run):
    query = {"source": "github", "connectionId": connection, "commitSha": run["commit"],
             "limit": 500, "order": "asc"}
    rows = []
    for _ in range(20):
        result = request(base + "/api/events?" + urllib.parse.urlencode(query), token)
        rows.extend(result["items"])
        if not result.get("nextCursor"):
            return matching_events(rows, repo, connection, run)
        query["cursor"] = result["nextCursor"]
    raise RuntimeError("Event page limit exceeded; narrow the acceptance fixture")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, help="Public standalone demo owner/repo")
    parser.add_argument("--connection-id", required=True)
    parser.add_argument("--run-ids", required=True, nargs=2, type=int, metavar=("VERSION_1", "VERSION_2"))
    parser.add_argument("--wait-seconds", type=int, default=600)
    args = parser.parse_args()
    require(re.fullmatch(r"[\w.-]+/[\w.-]+", args.repository), "Invalid repository name")
    require(all(x > 0 for x in args.run_ids), "Run IDs must be positive")
    base = os.environ.get("AFE_DEMO_URL", "").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    require((parsed.scheme == "https" or (parsed.scheme == "http" and local))
            and parsed.hostname and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment and not parsed.path,
            "AFE_DEMO_URL must be an HTTPS origin, or HTTP on loopback for local testing")
    token = os.environ.get("AFE_ADMIN_TOKEN")
    require(token, "Set AFE_ADMIN_TOKEN privately in the environment")
    connection = request(base + "/api/connections/" + urllib.parse.quote(args.connection_id, safe="")
                         + "/health", token)["connection"]
    require(connection.get("source") == "github" and connection.get("status") == "active",
            "Expected an active GitHub connection")
    runs = [source_run(args.repository, run_id, version)
            for version, run_id in enumerate(args.run_ids, 1)]
    require(runs[0]["commit"] != runs[1]["commit"], "Versions must use different commits")
    deadline = time.monotonic() + args.wait_seconds
    pending = list(runs)
    while pending:
        for run in list(pending):
            matches = collect_events(base, token, args.repository, args.connection_id, run)
            if matches:
                run["events"] = [{"id": row["event"]["id"], "action": row["event"]["action"],
                                  "commitShas": row["event"]["correlation"]["commitShas"],
                                  "method": row["provenance"]["method"]}
                                 for row in matches.values()]
                pending.remove(run)
                print(f"PASS: Version {run['version']} workflow and deployment match Afe", flush=True)
        if pending:
            require(time.monotonic() < deadline, "Timed out waiting for matching Afe events")
            time.sleep(5)
    output = pathlib.Path("github-evidence")
    output.mkdir(exist_ok=True)
    report = {"result": "passed", "repository": args.repository,
              "connectionId": args.connection_id, "runs": runs}
    (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    if os.environ.get("AFE_CAPTURE_SCRIPT"):
        subprocess.run(["node", os.environ["AFE_CAPTURE_SCRIPT"]], check=True,
                       env={**os.environ, "AFE_EVIDENCE_DIR": str(output.resolve()),
                            "AFE_CONNECTION_ID": args.connection_id})
    summary = ("## GitHub Pages → Afe acceptance passed\n\n"
               "Two real GitHub runs and successful Pages deployment statuses match Afe "
               "by connection, repository, commit, run and deployment/status IDs.\n\n"
               "See results.json for source links and event evidence. "
               "Recordings show Afe's captured history; this verifier does not deploy the site "
               "or claim to have viewed its historical live versions.\n")
    (output / "README.md").write_text(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(summary)


if __name__ == "__main__":
    main()
