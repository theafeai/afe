"""Real Terraform/Docker -> signed reporter -> production Afe acceptance.

Terraform state, plans, process logs and credentials never enter the evidence.
"""
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:8084"


def request(path, token, data=None):
    req = urllib.request.Request(BASE + path, data=None if data is None else json.dumps(data).encode(),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def wait(check, label, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                print("PASS: " + label, flush=True)
                return result
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Timed out: " + label)


def main():
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="afe-terraform-"))
    working = scratch / "demo"
    shutil.copytree(ROOT / "examples/demo", working, ignore=shutil.ignore_patterns(
        ".terraform", "*.tfstate*", "*.tfplan", "*.tfvars", ".vercel", "secrets"))
    token = secrets.token_hex(32)
    server_env = {**os.environ, "AFE_HOST": "127.0.0.1", "AFE_PORT": "8084",
                  "AFE_WEB_DIR": str(ROOT / "apps/web/dist"), "AFE_ADMIN_TOKEN": token,
                  "AFE_ENCRYPTION_KEY": secrets.token_urlsafe(32), "AFE_LOG_LEVEL": "warn"}
    # A local developer may have _FILE credentials; use only this ephemeral pair.
    server_env.pop("AFE_ADMIN_TOKEN_FILE", None)
    server_env.pop("AFE_ENCRYPTION_KEY_FILE", None)
    # Key loader expects base64, not base64url.
    import base64
    server_env["AFE_ENCRYPTION_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
    log = open(scratch / "afe.log", "w")
    server = subprocess.Popen(["node", "apps/server/dist/cli.js", "all"], cwd=ROOT, env=server_env,
                              stdout=log, stderr=subprocess.STDOUT)
    tf_log = open(scratch / "terraform.log", "w")
    initialized = False
    destroyed = False
    evidence = []
    try:
        wait(lambda: server.poll() is None and request("/healthz", token), "production Afe ready")
        repository = os.environ.get("GITHUB_REPOSITORY", "theafeai/afe")
        connected = request("/api/connections/terraform", token, {"workspace": "local-docker-demo",
                            "environment": "development", "repository": repository})
        connection_id = connected["connection"]["id"]
        report_env = {**os.environ, "AFE_TERRAFORM_REPORT_URL": BASE + connected["reportPath"],
                      "AFE_TERRAFORM_SECRET": connected["secret"]}
        report_env.pop("AFE_TERRAFORM_SECRET_FILE", None)
        subprocess.run(["terraform", "-chdir=terraform", "init", "-input=false"], cwd=working,
                       check=True, stdout=tf_log, stderr=subprocess.STDOUT)
        initialized = True

        def run(operation, args, expected_exit, expected_outcome):
            run_id = str(uuid.uuid4())
            reporter = ["python3", str(ROOT / "tools/terraform-report.py"), "--run-id", run_id,
                        "--operation", operation]
            subprocess.run(reporter + ["--phase", "started"], env=report_env, check=True)
            result = subprocess.run(["terraform", "-chdir=terraform", *args], cwd=working,
                                    stdout=tf_log, stderr=subprocess.STDOUT)
            if result.returncode != expected_exit:
                raise RuntimeError(f"Unexpected {operation} exit code {result.returncode}; expected {expected_exit}")
            completed = reporter + ["--phase", "completed", "--exit-code", str(result.returncode)]
            subprocess.run(completed, env=report_env, check=True)
            # Real re-delivery with the same source key must not create another event.
            subprocess.run(completed, env=report_env, check=True)
            query = urllib.parse.urlencode({"source": "terraform", "connectionId": connection_id,
                                            "runId": f"terraform:{connected['connection']['externalId']}:{run_id}", "limit": 100})
            def captured():
                rows = request("/api/events?" + query, token)["items"]
                started = [r for r in rows if r["event"]["action"] == f"terraform.{operation}.started"]
                finished = [r for r in rows if r["event"]["action"] == f"terraform.{operation}.completed"
                            and r["event"]["outcome"] == expected_outcome]
                if len(started) == 1 and len(finished) == 1 and len(rows) == 2:
                    return finished[0]["event"]
                return None
            event = wait(captured, f"{operation} exit {result.returncode}: one start and one {expected_outcome} completion")
            evidence.append({"operation": operation, "exitCode": result.returncode,
                             "outcome": event["outcome"], "eventId": event["id"],
                             "runId": run_id, "commitShas": event["correlation"].get("commitShas", []),
                             "attribution": event["data"]["attribution"]})

        run("plan", ["plan", "-detailed-exitcode", "-input=false"], 2, "succeeded")
        run("apply", ["apply", "-auto-approve", "-input=false"], 0, "succeeded")

        def page(version):
            def ready():
                with urllib.request.urlopen("http://127.0.0.1:8092/", timeout=3) as response:
                    return version in response.read().decode()
            wait(ready, "real Docker app serves " + version)

        page("Version 1")
        run("plan", ["plan", "-detailed-exitcode", "-input=false"], 0, "succeeded")
        site = working / "site/index.html"
        site.write_text(site.read_text().replace("Version 1", "Version 2"))
        run("apply", ["apply", "-auto-approve", "-input=false"], 0, "succeeded")
        page("Version 2")
        run("plan", ["plan", "-input=false", "-var=port=1"], 1, "failed")
        run("destroy", ["destroy", "-auto-approve", "-input=false"], 0, "succeeded")
        destroyed = True
        output = ROOT / "terraform-evidence"
        output.mkdir(exist_ok=True)
        (output / "results.json").write_text(json.dumps({"result": "passed", "source": "real Terraform CLI and Docker",
            "connectionId": connection_id, "reports": evidence, "cleanup": "terraform destroy succeeded"}, indent=2) + "\n")
        if os.environ.get("AFE_CAPTURE_SCRIPT"):
            subprocess.run(["node", os.environ["AFE_CAPTURE_SCRIPT"]], check=True,
                           env={**os.environ, "AFE_DEMO_URL": BASE, "AFE_BROWSER_TOKEN": token,
                                "AFE_CONNECTION_ID": connection_id, "AFE_EVIDENCE_DIR": str(output)})
        summary = "## Terraform → Afe acceptance passed\n\nReal Docker app served Version 1 then Version 2. " \
                  "Real plan changes/no changes, two applies, validation failure and destroy were reported and ingested. " \
                  "Each run has one start and one completion despite redelivery. Terraform destroy succeeded. " \
                  "Evidence contains metadata only; no state, plans, logs or credentials.\n"
        (output / "README.md").write_text(summary)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write(summary)
    finally:
        if initialized and not destroyed:
            destroyed = subprocess.run(["terraform", "-chdir=terraform", "destroy", "-auto-approve", "-input=false"],
                cwd=working, stdout=tf_log, stderr=subprocess.STDOUT).returncode == 0
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill(); server.wait()
        log.close(); tf_log.close()
        if not initialized or destroyed:
            shutil.rmtree(scratch)
        else:
            raise RuntimeError("Cleanup failed; Terraform state retained in the private temporary working directory")


if __name__ == "__main__":
    main()
