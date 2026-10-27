# ArgoCD in a local kind cluster

This deploys the same page in local Kubernetes and observes a real ArgoCD sync.
Use a disposable cluster. Requirements: Docker with several GB of free memory,
[kind](https://kind.sigs.k8s.io/docs/user/quick-start/), `kubectl`, ArgoCD CLI,
and the [public standalone demo Git repository](README.md). ArgoCD needs to
fetch the repo; changes in your working tree are not a GitOps deployment.

## Create the local cluster and ArgoCD

```sh
kind create cluster --name afe-demo --wait 120s
kubectl --context kind-afe-demo create namespace argocd
kubectl --context kind-afe-demo apply --server-side -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.6/manifests/install.yaml
kubectl --context kind-afe-demo -n argocd rollout status deployment/argocd-server --timeout=300s
kubectl --context kind-afe-demo -n argocd rollout status statefulset/argocd-application-controller --timeout=300s
```

All following `kubectl` commands target `kind-afe-demo` explicitly. Do not point
them at an existing shared cluster. If readiness times out, inspect pods and
image-pull events before continuing.

For this isolated lab, serve the ArgoCD API over private HTTP so both the host
CLI and a containerized Afe can reach it without a custom certificate setup:

```sh
kubectl --context kind-afe-demo -n argocd patch configmap argocd-cmd-params-cm \
  --type merge -p '{"data":{"server.insecure":"true"}}'
kubectl --context kind-afe-demo -n argocd rollout restart deployment/argocd-server
kubectl --context kind-afe-demo -n argocd rollout status deployment/argocd-server --timeout=180s
kubectl --context kind-afe-demo -n argocd patch service argocd-server --type merge \
  -p '{"spec":{"type":"NodePort","ports":[{"name":"http","port":80,"protocol":"TCP","targetPort":8080,"nodePort":30080},{"name":"https","port":443,"protocol":"TCP","targetPort":8080,"nodePort":30443}]}}'
kubectl --context kind-afe-demo -n argocd port-forward service/argocd-server 8091:80 --address 127.0.0.1
```

Leave the port-forward running. Open <http://127.0.0.1:8091/>. This is an explicit
private lab HTTP configuration, not disabled certificate verification. For a
shared/production setup, use HTTPS and supply Afe the trusted CA instead.

In another terminal, retrieve the initial admin password locally:

```sh
kubectl --context kind-afe-demo -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 --decode
```

Use it at the ArgoCD login prompt (do not commit or paste it into issue logs):

```sh
argocd login 127.0.0.1:8091 --plaintext --username admin
```

## Connect Afe with a separate read-only account

```sh
kubectl --context kind-afe-demo -n argocd patch configmap argocd-cm --type merge \
  -p '{"data":{"accounts.afe":"apiKey"}}'
kubectl --context kind-afe-demo -n argocd patch configmap argocd-rbac-cm --type merge \
  -p '{"data":{"policy.default":"","policy.csv":"p, role:afe-readonly, applications, get, */*, allow\np, role:afe-readonly, projects, get, *, allow\np, role:afe-readonly, clusters, get, *, allow\ng, afe, role:afe-readonly"}}'
argocd account generate-token --account afe --id afe-demo --expires-in 24h
```

The policy replacement above is for this new disposable cluster only. Do not
use the ArgoCD admin session/token to connect Afe: Afe rejects write-capable
accounts. Keep the generated read-only token private.

If Afe runs directly on the host, connect it to `http://127.0.0.1:8091` while
the port-forward runs. If Afe runs in the shared guide's Docker Compose stack,
run these commands **from the Afe checkout** to join its two containers to
kind's private Docker network:

```sh
docker network connect kind "$(docker compose ps -q afe-server)"
docker network connect kind "$(docker compose ps -q afe-worker)"
```

Then the URL from Afe is `http://afe-demo-control-plane:30080` (not localhost).
On either setup, enable `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true` and
`AFE_ALLOW_INSECURE_HTTP_TARGETS=true` on the **dedicated lab Afe**, recreating
the services if needed. For Compose, set the values in `.env`, recreate first,
then run the network-connect commands; recreation removes network attachments.

In Afe **Connections → ArgoCD**, enter that URL, the read-only token, and name
`afe-demo-kind`. Test the connection and confirm its health. Both Afe server
and worker need network access. If repeating `docker network connect` says
already connected, no change is needed.

An alternative for a private/firewalled cluster is the
[in-cluster agent](../docs/connectors/argocd.md#in-cluster-agent): register an
agent in Afe, create its Kubernetes Secret and use the supplied Helm chart or
manifests, with an actual built/released agent image and HTTPS access to Afe.
That path does not require exposing the ArgoCD API to Afe; its URL, secret,
network policy CIDRs and CA must match your setup. The simpler pull path above
is sufficient for this local sample; do not create both connections for the
same instance unless testing duplicate observations deliberately.

## Deploy, change and observe

From the standalone demo directory:

```sh
DEMO_REPO_URL=$(git remote get-url origin)
argocd app create afe-demo --repo "$DEMO_REPO_URL" --path . --revision main \
  --dest-server https://kubernetes.default.svc --dest-namespace afe-demo \
  --sync-option CreateNamespace=true
argocd app sync afe-demo
argocd app wait afe-demo --sync --health --timeout 180
kubectl --context kind-afe-demo -n afe-demo port-forward service/afe-demo 8090:8080 --address 127.0.0.1
```

Visit <http://127.0.0.1:8090/> and confirm Version 1 (or the current committed
version if you already followed another guide). Kustomize generates a
content-named ConfigMap; changing the page changes the deployment's ConfigMap
reference and rolls out the new page, rather than leaving an old pod running.

In another terminal, edit `site/index.html` to the next version, commit and
push it to main. Then:

```sh
argocd app get afe-demo --hard-refresh
argocd app sync afe-demo
argocd app wait afe-demo --sync --health --timeout 180
```

Refresh the page. In Afe, filter Timeline to **ArgoCD** and application
`afe-demo`: expect app creation/change and sync lifecycle, revision/commit and
health observations where the source supplies them. Map this app to service
`afe-demo` / environment `local` under **Mapping**. Its latest observed revision
should appear in the environment matrix. Connect GitHub to the same repo to
link commit journeys; missing image-build evidence may still be marked unknown
because this example uses a prebuilt public nginx image.

For a rollback exercise after two successful deploys, inspect
`argocd app history afe-demo`, then `argocd app rollback afe-demo HISTORY_ID`
using a real ID from that output. Wait for health and inspect Afe again. Sync
main afterward to restore the latest version.

## Troubleshooting and cleanup

- Connection refused: check port-forward (host mode), NodePort, both Docker
  network attachments (Compose mode), HTTP lab opt-ins and connection URL.
  `127.0.0.1` inside Afe's container is Afe, not your host or kind node.
- Connection rejected as write-capable: use `afe`'s token, not admin, and check
  that the lab RBAC default is empty and no other role grants writes.
- App cannot fetch Git: use a public HTTPS Git URL and push the changed commit.
- Sync succeeds but old version remains: compare the synced commit, generated
  ConfigMap and pod rollout; hard-refresh the browser. A changed working tree
  without a pushed commit does not change ArgoCD's source.
- Cleanup: delete the ArgoCD app with `argocd app delete afe-demo --cascade`
  and confirm the prompt. Disconnect this connection in Afe, revoke the token
  (`argocd account delete-token --account afe afe-demo`), stop port-forwards,
  then delete only the demo cluster: `kind delete cluster --name afe-demo`.
  If reusing Afe, remove its lab HTTP/private-target opt-ins when no longer
  needed. Keep the demo Git repo until the other guides are complete.

Reference: [ArgoCD getting started](https://argo-cd.readthedocs.io/en/stable/getting_started/).
