"""Real ArgoCD -> production Afe -> PostgreSQL acceptance run on a CI runner.

Only a whitelisted evidence report and browser images leave the runner. Tokens,
database credentials, kubeconfig and process logs stay in the temporary folder.
"""

import base64
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "argocd-evidence"
OUTPUT.mkdir(exist_ok=True)
PROCESSES = []


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def kube(*args):
    return command("kubectl", *args)


def apply(value):
    subprocess.run(["kubectl", "apply", "-f", "-"], input=json.dumps(value), text=True, check=True)


def request(url, data=None, token=None, method=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            body = response.read().decode()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        # Never include a response body or authentication headers in logs.
        raise RuntimeError(f"HTTP {error.code}: {req.method} {urllib.parse.urlsplit(url).path}") from None


def until(check, label, seconds=180):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                print(f"PASS: {label}", flush=True)
                return result
        except (OSError, RuntimeError, ValueError) as error:
            last = str(error)
        time.sleep(2)
    raise RuntimeError(f"Timed out: {label}; last status: {last}")


def launch(args, scratch, name, env=None):
    log = open(scratch / (name + ".log"), "w")
    process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    PROCESSES.append((process, log))
    return process


def capture(stage, token, connection_id, scratch):
    port, expected = (8090, "Version 1") if stage == "version-1" else (8092, "Version 2")
    def page_ready():
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as response:
            return expected in response.read().decode()
    until(page_ready, f"application serves {expected}")
    env = {**os.environ, "AFE_BROWSER_TOKEN": token, "AFE_CONNECTION_ID": connection_id,
           "AFE_CAPTURE_STAGE": stage, "AFE_EVIDENCE_DIR": str(OUTPUT)}
    subprocess.run(["node", os.environ["AFE_CAPTURE_SCRIPT"]], env=env, check=True)


def main(scratch):
    # A real, small Git remote inside the cluster permits two actual commits
    # without GitHub write credentials or changes to the public sample repo.
    working = scratch / "working"
    shutil.copytree(ROOT / "examples/demo", working, ignore=shutil.ignore_patterns(
        ".terraform", "*.tfstate*", "*.tfplan", "*.tfvars", ".vercel", "secrets"))
    command("git", "init", "-b", "main", str(working))
    command("git", "-C", str(working), "config", "user.name", "Afe CI Demo")
    command("git", "-C", str(working), "config", "user.email", "noreply@openai.com")

    def commit(message):
        command("git", "-C", str(working), "add", ".")
        command("git", "-C", str(working), "commit", "-m", message)
        return command("git", "-C", str(working), "rev-parse", "HEAD")

    first_sha = commit("Deploy Version 1")
    remote = scratch / "demo.git"
    command("git", "clone", "--bare", str(working), str(remote))
    command("git", "--git-dir", str(remote), "update-server-info")
    apply({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "afe-demo-git"}})
    apply({"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "git", "namespace": "afe-demo-git"},
           "spec": {"automountServiceAccountToken": False, "containers": [{"name": "git",
               "image": "python:3.12-alpine", "command": ["python3", "-m", "http.server", "8080", "--directory", "/srv"],
               "volumeMounts": [{"name": "repo", "mountPath": "/srv"}],
               "readinessProbe": {"httpGet": {"path": "/", "port": 8080}},
               "resources": {"requests": {"cpu": "10m", "memory": "32Mi"}, "limits": {"memory": "128Mi"}}}],
               "volumes": [{"name": "repo", "emptyDir": {}}]}})
    apply({"apiVersion": "v1", "kind": "Service", "metadata": {"name": "git", "namespace": "afe-demo-git"},
           "spec": {"selector": {"app": "afe-demo-git"}, "ports": [{"port": 8080, "targetPort": 8080}]}})
    kube("-n", "afe-demo-git", "label", "pod/git", "app=afe-demo-git")
    kube("-n", "afe-demo-git", "wait", "pod/git", "--for=condition=Ready", "--timeout=180s")

    def publish():
        command("git", "--git-dir", str(remote), "update-server-info")
        kube("cp", str(remote), "afe-demo-git/git:/srv/")

    publish()
    launch(["kubectl", "-n", "argocd", "port-forward", "service/argocd-server", "8091:80"], scratch, "argocd")
    until(lambda: request("http://127.0.0.1:8091/api/version"), "ArgoCD API reachable")
    password = base64.b64decode(json.loads(kube("-n", "argocd", "get", "secret", "argocd-initial-admin-secret", "-o", "json"))["data"]["password"]).decode()
    admin = request("http://127.0.0.1:8091/api/v1/session", {"username": "admin", "password": password})["token"]
    readonly = until(lambda: request("http://127.0.0.1:8091/api/v1/account/afe/token",
                                     {"id": "afe-ci", "expiresIn": 3600}, admin)["token"], "read-only ArgoCD token issued")

    afe_token = secrets.token_hex(32)
    env = {**os.environ, "AFE_HOST": "127.0.0.1", "AFE_PORT": "8080", "AFE_ADMIN_TOKEN": afe_token,
           "AFE_ENCRYPTION_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
           "AFE_WEB_DIR": str(ROOT / "apps/web/dist"), "AFE_LOG_LEVEL": "warn",
           "AFE_ALLOW_PRIVATE_NETWORK_TARGETS": "true", "AFE_ALLOW_INSECURE_HTTP_TARGETS": "true"}
    server = launch(["node", "apps/server/dist/cli.js", "all"], scratch, "afe", env)
    until(lambda: server.poll() is None and request("http://127.0.0.1:8080/healthz"), "Afe production server ready")

    def afe(path, data=None):
        return request("http://127.0.0.1:8080" + path, data, afe_token)

    connected = afe("/api/connections/argocd", {"url": "http://127.0.0.1:8091", "token": readonly, "name": "Real ArgoCD CI demo"})
    assert connected["readOnlyCheck"]["status"] == "verified", "ArgoCD read-only permissions were not verified"
    connection_id = connected["connection"]["id"]
    print("PASS: Afe accepted the read-only ArgoCD connection", flush=True)
    apply({"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
           "metadata": {"name": "afe-demo", "namespace": "argocd"}, "spec": {"project": "default",
               "source": {"repoURL": "http://git.afe-demo-git.svc.cluster.local:8080/demo.git", "targetRevision": first_sha, "path": "."},
               "destination": {"server": "https://kubernetes.default.svc", "namespace": "afe-demo"},
               "syncPolicy": {"syncOptions": ["CreateNamespace=true"]}}})

    def app():
        return request("http://127.0.0.1:8091/api/v1/applications/afe-demo", token=admin)

    def events_for(sha):
        query = urllib.parse.urlencode({"source": "argocd", "connectionId": connection_id,
                                        "action": "argocd.sync.succeeded", "limit": 500, "order": "asc"})
        rows = afe("/api/events?" + query)["items"]
        return [row for row in rows if sha in row["event"]["correlation"].get("commitShas", [])
                and row["event"]["target"].get("application") == "afe-demo"]

    results = []

    def sync(sha, version):
        # Pin desired state as well as the operation. The small HTTP Git remote
        # supports commit fetches; it does not implement smart branch-ref RPCs.
        kube("-n", "argocd", "patch", "application", "afe-demo", "--type", "merge",
             "-p", json.dumps({"spec": {"source": {"targetRevision": sha}}}))
        until(lambda: request("http://127.0.0.1:8091/api/v1/applications/afe-demo?refresh=hard", token=admin), "Git source refreshed")
        until(lambda: request("http://127.0.0.1:8091/api/v1/applications/afe-demo/sync",
                              {"revision": sha, "prune": True}, admin), f"Version {version} sync requested")

        def healthy():
            status = app().get("status", {})
            phase = status.get("operationState", {}).get("phase")
            if phase in ("Failed", "Error"):
                raise AssertionError(f"ArgoCD sync ended with {phase}")
            return (status.get("sync", {}).get("revision") == sha
                    and status.get("sync", {}).get("status") == "Synced"
                    and phase == "Succeeded"
                    and status.get("health", {}).get("status") == "Healthy")

        until(healthy, f"ArgoCD Version {version} synced and healthy", 240)
        kube("-n", "afe-demo", "rollout", "status", "deployment/afe-demo", "--timeout=180s")
        found = until(lambda: events_for(sha), f"Afe recorded successful sync for {sha}")
        results.append({"version": version, "commit": sha, "events": [
            {"id": row["event"]["id"], "action": row["event"]["action"], "outcome": row["event"]["outcome"],
             "commitShas": row["event"]["correlation"].get("commitShas", []), "method": row["provenance"]["method"]}
            for row in found]})

    sync(first_sha, 1)
    launch(["kubectl", "-n", "afe-demo", "port-forward", "service/afe-demo", "8090:8080"], scratch, "demo")
    capture("version-1", afe_token, connection_id, scratch)
    page = working / "site/index.html"
    page.write_text(page.read_text().replace("Version 1", "Version 2"))
    second_sha = commit("Deploy Version 2")
    command("git", "-C", str(working), "push", str(remote), "main")
    publish()
    sync(second_sha, 2)
    # A rolling update may terminate kubectl's selected pod. Start a fresh forward.
    launch(["kubectl", "-n", "afe-demo", "port-forward", "service/afe-demo", "8092:8080"], scratch, "demo-v2")
    capture("version-2", afe_token, connection_id, scratch)
    report = {"result": "passed", "connectionId": connection_id, "source": "real ArgoCD API",
              "database": "PostgreSQL", "runs": results}
    (OUTPUT / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    rows = ["## ArgoCD → Afe acceptance", "", "Real Git commits, real ArgoCD, production Afe server and PostgreSQL.",
            "", "| App | Commit | Afe event | Observation |", "|---|---|---|---|"]
    for result in results:
        for event in result["events"]:
            rows.append(f"| Version {result['version']} | `{result['commit']}` | `{event['action']}` | {event['method']} |")
    rows += ["", "Download **argocd-afe-evidence** for screenshots, browser recordings and the JSON evidence report.",
             "The disposable cluster and Afe instance are removed after this job. No live URL is retained."]
    summary = "\n".join(rows) + "\n"
    (OUTPUT / "README.md").write_text(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(summary)


if __name__ == "__main__":
    try:
        with tempfile.TemporaryDirectory(prefix="afe-argocd-") as directory:
            main(pathlib.Path(directory))
    finally:
        for process, log in reversed(PROCESSES):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            log.close()
