/**
 * SYNTHETIC dataset for AFE-15 (cross-tool flow research).
 *
 * Every event below is invented. Shapes follow the canonical event model
 * (docs/event-model.md) and the source fields they would be mapped from are
 * kept, abbreviated, in `rawPayload` (GitHub webhooks, ArgoCD Application
 * status, Vercel webhooks/REST). Nothing here was recorded from a real
 * system; see docs/research/0001-cross-tool-flow.md, "Re-run on real data".
 *
 * Scenarios:
 *  (a) acme/shop monorepo -> GitHub Actions builds ghcr.io/acme/shop-api:<sha>
 *      -> bot bumps acme/shop-deploy (GitOps repo) -> ArgoCD auto-sync to staging;
 *      a human PR promotes to production pinning the digest.
 *  (b) acme/web Next.js on Vercel: preview per PR, production on main, an
 *      instant rollback, a promote after rollback, a redeploy.
 *  (c) manual: `argocd app set --kustomize-image` + `argocd app sync` of a
 *      hotfix image, and `vercel deploy --prod` from a laptop without Git metadata.
 *  (d) acme/worker: the mutable tag ghcr.io/acme/worker:1.4 is rebuilt from a
 *      different commit; a later production restart cannot tell which build runs.
 *
 * Proposed (not yet schema) correlation keys are carried in
 * `data.correlationHints`; the prototype reads them from there.
 */
import { createHash } from "node:crypto";
import {
  parseEventInput,
  sourceEventId,
  type CanonicalEventInputLike,
} from "../../../packages/core/src/index.ts";
import type { CorrelationEvent } from "../../../packages/core/src/correlation/index.ts";

const sha1 = (label: string) => createHash("sha1").update(label).digest("hex");
const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;

/** Named commits and digests, for tests and the doc. */
export const C = {
  // acme/shop
  A: sha1("shop:A add discount codes"),
  B: sha1("shop:B faster cart"),
  D: sha1("shop:D broken test"),
  // acme/shop-deploy (GitOps)
  C1: sha1("deploy:C1 bump staging A"),
  C2: sha1("deploy:C2 promote A to production"),
  H88: sha1("deploy:H88 PR head"),
  C3: sha1("deploy:C3 bump staging B"),
  C4: sha1("deploy:C4 worker 1.4"),
  C5: sha1("deploy:C5 pin worker digest on staging"),
  // acme/worker
  W: sha1("worker:W v1.4.0"),
  W2: sha1("worker:W2 backport on release/1.4"),
  // acme/web
  P1: sha1("web:P1 checkout PR"),
  M1: sha1("web:M1 merge PR 42"),
  M2: sha1("web:M2 broken header"),
  M3: sha1("web:M3 fix header"),
  M4: sha1("web:M4 copy tweak"),
  X0: sha1("shop:previous"),
} as const;

export const DG = {
  DA: digest("shop-api A"),
  DB: digest("shop-api B"),
  DW1: digest("worker 1.4 build 1"),
  DW2: digest("worker 1.4 rebuild"),
} as const;

const REPO = {
  shop: "github.com/acme/shop",
  deploy: "github.com/acme/shop-deploy",
  worker: "github.com/acme/worker",
  web: "github.com/acme/web",
} as const;
const REPO_ID: Record<keyof typeof REPO, number> = {
  shop: 700001,
  deploy: 700002,
  worker: 700003,
  web: 700004,
};

const ACTORS = {
  dana: { type: "user", id: "1001", login: "dana" },
  erin: { type: "user", id: "1002", login: "erin" },
  kim: { type: "user", id: "1003", login: "kim" },
  ghActions: { type: "bot", id: "41898282", login: "github-actions[bot]" },
  releaseBot: { type: "bot", id: "2002", login: "acme-release[bot]" },
  renovate: { type: "bot", id: "29139614", login: "renovate[bot]" },
  vercelBot: { type: "bot", id: "35613825", login: "vercel[bot]" },
  argocd: { type: "system", id: "argocd-application-controller", login: "automated" },
  alice: { type: "user", id: "alice@acme.example", login: "alice@acme.example" },
  vKim: { type: "user", id: "usr_kim", login: "kim" },
  vFrank: { type: "user", id: "usr_frank", login: "frank" },
  vErin: { type: "user", id: "usr_erin", login: "erin" },
} satisfies Record<string, CanonicalEventInputLike["actor"]>;

type Input = CanonicalEventInputLike & { id: string };
const events: Input[] = [];
let n = 0;

function at(day: number, hhmmss: string) {
  return `2026-10-${String(day).padStart(2, "0")}T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}Z`;
}

function emit(
  e: Omit<CanonicalEventInputLike, "observedAt" | "observation"> & {
    method?: "webhook" | "poll" | "stream";
    raw?: unknown;
  },
) {
  const { method = "webhook", raw, ...rest } = e;
  const occurred = String(rest.occurredAt);
  events.push({
    id: `evt-${String(++n).padStart(3, "0")}`,
    ...rest,
    observedAt: new Date(Date.parse(occurred) + 2000).toISOString(),
    observation: { method },
    rawPayload: raw ? { contentType: "application/json", body: JSON.stringify(raw) } : null,
  });
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function push(p: {
  repo: keyof typeof REPO;
  ref: string;
  before: string;
  head: string;
  commits?: string[];
  actor: CanonicalEventInputLike["actor"];
  t: string;
  created?: boolean;
  hints?: Record<string, string[]>;
}) {
  const commits = p.commits ?? [p.head];
  emit({
    source: "github",
    sourceEventId: sourceEventId("push", REPO_ID[p.repo], p.ref, p.before, p.head),
    action: p.created ? "ref.created" : "ref.pushed",
    actor: p.actor,
    target: {
      type: "ref",
      id: `${REPO[p.repo].slice(11)}:${p.ref}`,
      repository: REPO[p.repo].slice(11),
      ref: p.ref,
    },
    trigger: { type: p.ref.startsWith("refs/tags/") ? "tag" : "push", sourceValue: "push" },
    outcome: "none",
    occurredAt: p.t,
    correlation: { commitShas: commits, refs: [p.ref], repositories: [REPO[p.repo]] },
    // Only extracted identifiers are kept from commit messages (R8 data minimisation).
    data: {
      headCommit: p.head,
      commitCount: commits.length,
      ...(p.hints ? { correlationHints: p.hints } : {}),
    },
    raw: {
      ref: p.ref,
      before: p.before,
      after: p.head,
      created: Boolean(p.created),
      repository: { id: REPO_ID[p.repo], full_name: REPO[p.repo].slice(11) },
      pusher: { name: p.actor.login },
      commits: commits.map((id) => ({ id })),
    },
  });
}

function run(p: {
  repo: keyof typeof REPO;
  runId: number;
  name: string;
  head: string;
  ref: string;
  phase: "requested" | "completed";
  conclusion?: "success" | "failure";
  event: string;
  trigger: "push" | "tag" | "manual" | "schedule";
  actor: CanonicalEventInputLike["actor"];
  t: string;
}) {
  emit({
    source: "github",
    sourceEventId: sourceEventId("workflow_run", p.runId, 1, p.phase),
    action: `workflow_run.${p.phase}`,
    actor: p.actor,
    target: {
      type: "workflow_run",
      id: `${REPO[p.repo].slice(11)}/actions/runs/${p.runId}`,
      name: p.name,
      repository: REPO[p.repo].slice(11),
      ref: p.ref,
    },
    trigger: { type: p.trigger, sourceValue: p.event },
    outcome:
      p.phase === "requested" ? "pending" : p.conclusion === "success" ? "succeeded" : "failed",
    occurredAt: p.t,
    correlation: {
      commitShas: [p.head],
      refs: [p.ref],
      repositories: [REPO[p.repo]],
      runIds: [`github:${p.runId}`],
    },
    data: { workflow: p.name, runAttempt: 1 },
    raw: {
      action: p.phase,
      workflow_run: {
        id: p.runId,
        name: p.name,
        head_sha: p.head,
        head_branch: p.ref.replace(/^refs\/(heads|tags)\//, ""),
        event: p.event,
        run_attempt: 1,
        conclusion: p.conclusion ?? null,
      },
    },
  });
}

/**
 * Proposed `artifact.published`: from the GitHub `registry_package` webhook
 * (tag + digest) joined with the image's build provenance attestation or the
 * OCI label org.opencontainers.image.revision (commit) and the run id.
 */
function artifact(p: {
  repo: keyof typeof REPO;
  image: string;
  tags: string[];
  digest: string;
  commit: string;
  runId: number;
  t: string;
}) {
  emit({
    source: "github",
    sourceEventId: sourceEventId("registry_package", p.image, p.digest, "published"),
    action: "artifact.published",
    actor: ACTORS.ghActions,
    target: { type: "other", id: p.image, name: p.image, repository: REPO[p.repo].slice(11) },
    trigger: { type: "upstream", sourceValue: "registry_package" },
    outcome: "succeeded",
    occurredAt: p.t,
    correlation: {
      commitShas: [p.commit],
      repositories: [REPO[p.repo]],
      imageRefs: p.tags.map((tag) => `${p.image}:${tag}`),
      imageDigests: [p.digest],
      runIds: [`github:${p.runId}`],
    },
    data: { provenance: "attestation" },
    raw: {
      action: "published",
      registry_package: {
        name: p.image.split("/").at(-1),
        package_type: "CONTAINER",
        package_version: {
          version: p.digest,
          container_metadata: { tag: { name: p.tags[0], digest: p.digest } },
        },
      },
      attestation: {
        subject: [{ digest: { sha256: p.digest.slice(7) } }],
        predicate: {
          buildDefinition: {
            resolvedDependencies: [
              { uri: `git+https://${REPO[p.repo]}`, digest: { gitCommit: p.commit } },
            ],
          },
          runDetails: {
            metadata: {
              invocationId: `https://${REPO[p.repo]}/actions/runs/${p.runId}/attempts/1`,
            },
          },
        },
      },
    },
  });
}

function prMerged(p: {
  repo: keyof typeof REPO;
  number: number;
  prId: number;
  merge: string;
  head: string;
  actor: CanonicalEventInputLike["actor"];
  t: string;
  hints?: Record<string, string[]>;
}) {
  emit({
    source: "github",
    sourceEventId: sourceEventId("pull_request", p.prId, "merged"),
    action: "pull_request.merged",
    actor: p.actor,
    target: {
      type: "repository",
      id: REPO[p.repo].slice(11),
      repository: REPO[p.repo].slice(11),
      ref: "refs/heads/main",
    },
    trigger: { type: "pull_request", sourceValue: "pull_request" },
    outcome: "none",
    occurredAt: p.t,
    correlation: {
      commitShas: [p.merge, p.head],
      refs: ["refs/heads/main"],
      repositories: [REPO[p.repo]],
      pullRequests: [`${REPO[p.repo]}#${p.number}`],
    },
    data: { number: p.number, ...(p.hints ? { correlationHints: p.hints } : {}) },
    raw: {
      action: "closed",
      pull_request: {
        id: p.prId,
        number: p.number,
        merged: true,
        merge_commit_sha: p.merge,
        head: { sha: p.head },
      },
    },
  });
}

function ghDeployment(p: {
  id: number;
  statusId: number;
  env: string;
  sha: string;
  ref: string;
  url: string;
  t: string;
}) {
  const common = {
    source: "github",
    actor: ACTORS.vercelBot,
    target: {
      type: "environment" as const,
      id: `acme/web:${p.env}`,
      name: p.env,
      repository: "acme/web",
      environment: p.env,
      ref: p.ref,
    },
    trigger: { type: "api" as const, sourceValue: "vercel" },
    correlation: {
      commitShas: [p.sha],
      refs: [p.ref],
      repositories: [REPO.web],
      environments: [p.env],
      deploymentIds: [`github:${p.id}`],
    },
  };
  emit({
    ...common,
    sourceEventId: sourceEventId("deployment", p.id, "created"),
    action: "deployment.created",
    outcome: "pending",
    occurredAt: p.t,
    raw: {
      deployment: {
        id: p.id,
        sha: p.sha,
        ref: p.ref.replace("refs/heads/", ""),
        environment: p.env,
        creator: { login: "vercel[bot]" },
      },
    },
  });
  emit({
    ...common,
    sourceEventId: sourceEventId("deployment_status", p.statusId),
    action: "deployment.status_updated",
    outcome: "succeeded",
    occurredAt: new Date(Date.parse(p.t) + 125_000).toISOString(),
    data: { correlationHints: { deploymentUrls: [p.url] } },
    raw: {
      deployment_status: {
        id: p.statusId,
        state: "success",
        target_url: `https://${p.url}`,
        environment: p.env,
      },
      deployment: { id: p.id },
    },
  });
}

// ---------------------------------------------------------------------------
// ArgoCD helpers
// ---------------------------------------------------------------------------

function sync(p: {
  app: string;
  env: string;
  uid: string;
  revision: string;
  historyId: number;
  images: string[];
  digests?: string[];
  trigger: "auto_sync" | "manual";
  actor: CanonicalEventInputLike["actor"];
  t: string;
  started?: boolean;
  health?: boolean;
}) {
  const target = {
    type: "application" as const,
    id: `argocd/${p.app}`,
    application: p.app,
    project: p.app.split("-")[0],
    environment: p.env,
    cluster: "https://kubernetes.default.svc",
    namespace: `${p.app.replace(/-(staging|production)$/, "")}-${p.env}`,
    repository: "https://github.com/acme/shop-deploy.git",
  };
  const trig = {
    type: p.trigger,
    sourceValue: p.trigger === "auto_sync" ? "automated" : "argocd app sync",
  };
  const startedAt = p.t;
  const finishedAt = new Date(Date.parse(p.t) + 60_000).toISOString();
  const base = {
    source: "argocd",
    actor: p.actor,
    target,
    trigger: trig,
    method: "stream" as const,
  };
  if (p.started !== false) {
    emit({
      ...base,
      sourceEventId: sourceEventId("sync", p.uid, startedAt, "started"),
      action: "argocd.sync.started",
      outcome: "in_progress",
      occurredAt: startedAt,
      correlation: { commitShas: [p.revision], repositories: [REPO.deploy], environments: [p.env] },
      raw: {
        metadata: { name: p.app, uid: p.uid },
        status: {
          operationState: {
            phase: "Running",
            startedAt,
            operation: {
              sync: { revision: p.revision },
              initiatedBy:
                p.trigger === "auto_sync" ? { automated: true } : { username: p.actor.login },
            },
          },
        },
      },
    });
  }
  emit({
    ...base,
    sourceEventId: sourceEventId("sync", p.uid, startedAt, "finished"),
    action: "argocd.sync.succeeded",
    outcome: "succeeded",
    occurredAt: finishedAt,
    correlation: {
      commitShas: [p.revision],
      repositories: [REPO.deploy],
      environments: [p.env],
      imageRefs: p.images,
      imageDigests: p.digests ?? null,
      deploymentIds: [`argocd:argocd/${p.app}:${p.historyId}`],
    },
    data: { historyId: p.historyId },
    raw: {
      metadata: { name: p.app, namespace: "argocd", uid: p.uid },
      status: {
        operationState: {
          phase: "Succeeded",
          startedAt,
          finishedAt,
          syncResult: { revision: p.revision },
        },
        history: [{ id: p.historyId, revision: p.revision, deployedAt: finishedAt }],
        summary: { images: p.images.map((i, k) => (p.digests?.[k] ? `${i}@${p.digests[k]}` : i)) },
      },
    },
  });
  if (p.health) {
    emit({
      ...base,
      sourceEventId: sourceEventId(
        "health",
        p.uid,
        "Healthy",
        new Date(Date.parse(finishedAt) + 60_000).toISOString(),
      ),
      action: "argocd.health.changed",
      actor: ACTORS.argocd,
      trigger: { type: "system" },
      outcome: "none",
      occurredAt: new Date(Date.parse(finishedAt) + 60_000).toISOString(),
      correlation: { commitShas: [p.revision], repositories: [REPO.deploy], environments: [p.env] },
      data: { health: "Healthy", previous: "Progressing" },
    });
  }
}

// ---------------------------------------------------------------------------
// Vercel helpers
// ---------------------------------------------------------------------------

function vercel(p: {
  dpl: string;
  url: string;
  target: "production" | "preview";
  sha?: string;
  ref?: string;
  pr?: number;
  actor: CanonicalEventInputLike["actor"];
  trigger: "push" | "pull_request" | "redeploy" | "cli";
  t: string;
  aliasAssigned?: boolean;
  redeployOf?: string;
}) {
  const target = {
    type: "deployment" as const,
    id: p.dpl,
    url: `https://${p.url}`,
    project: "web",
    environment: p.target,
    repository: "acme/web",
    ...(p.ref ? { ref: p.ref } : {}),
  };
  const correlation = {
    commitShas: p.sha ? [p.sha] : null,
    refs: p.ref ? [p.ref] : null,
    // CLI deploys: the repository comes from the project's Git link, not the deployment.
    repositories: [REPO.web],
    environments: [p.target],
    deploymentIds: [`vercel:${p.dpl}`],
    pullRequests: p.pr ? [`${REPO.web}#${p.pr}`] : null,
  };
  const meta = p.sha
    ? {
        githubCommitSha: p.sha,
        githubCommitRef: p.ref?.replace("refs/heads/", ""),
        githubRepo: "web",
        githubOrg: "acme",
        ...(p.pr ? { githubPrId: String(p.pr) } : {}),
      }
    : {};
  const trig = {
    type: p.trigger,
    sourceValue:
      p.trigger === "cli" ? "vercel deploy --prod" : p.trigger === "redeploy" ? "redeploy" : "git",
  };
  emit({
    source: "vercel",
    sourceEventId: sourceEventId("deployment", p.dpl, "created"),
    action: "deployment.created",
    actor: p.actor,
    target,
    trigger: trig,
    outcome: "pending",
    occurredAt: p.t,
    correlation,
    data: {
      target: p.target,
      correlationHints: { deploymentUrls: [p.url] },
      ...(p.redeployOf ? { redeployOf: p.redeployOf } : {}),
    },
    raw: {
      type: "deployment.created",
      payload: {
        deployment: { id: p.dpl, url: p.url, meta },
        target: p.target,
        project: { id: "prj_web" },
      },
    },
  });
  emit({
    source: "vercel",
    sourceEventId: sourceEventId("deployment", p.dpl, "succeeded"),
    action: "deployment.status_updated",
    actor: p.actor,
    target,
    trigger: trig,
    outcome: "succeeded",
    occurredAt: new Date(Date.parse(p.t) + 120_000).toISOString(),
    correlation,
    data: {
      target: p.target,
      aliasAssigned: p.aliasAssigned ?? true,
      correlationHints: { deploymentUrls: [p.url] },
    },
    raw: {
      type: "deployment.succeeded",
      payload: {
        deployment: { id: p.dpl, url: p.url, meta },
        target: p.target,
        project: { id: "prj_web" },
      },
    },
  });
}

// ===========================================================================
// (a) shop: app repo -> image -> GitOps repo -> ArgoCD
// ===========================================================================

push({
  repo: "shop",
  ref: "refs/heads/main",
  before: C.X0,
  head: C.A,
  actor: ACTORS.dana,
  t: at(20, "09:00"),
});
run({
  repo: "shop",
  runId: 9001,
  name: "build-and-bump",
  head: C.A,
  ref: "refs/heads/main",
  phase: "requested",
  event: "push",
  trigger: "push",
  actor: ACTORS.dana,
  t: at(20, "09:00:05"),
});
artifact({
  repo: "shop",
  image: "ghcr.io/acme/shop-api",
  tags: [C.A],
  digest: DG.DA,
  commit: C.A,
  runId: 9001,
  t: at(20, "09:06"),
});
push({
  repo: "deploy",
  ref: "refs/heads/main",
  before: C.X0,
  head: C.C1,
  actor: ACTORS.releaseBot,
  t: at(20, "09:07"),
  hints: { mentionedCommitShas: [C.A] },
});
run({
  repo: "shop",
  runId: 9001,
  name: "build-and-bump",
  head: C.A,
  ref: "refs/heads/main",
  phase: "completed",
  conclusion: "success",
  event: "push",
  trigger: "push",
  actor: ACTORS.dana,
  t: at(20, "09:07:30"),
});
sync({
  app: "shop-api-staging",
  env: "staging",
  uid: "uid-shop-stg",
  revision: C.C1,
  historyId: 41,
  images: [`ghcr.io/acme/shop-api:${C.A}`],
  trigger: "auto_sync",
  actor: ACTORS.argocd,
  t: at(20, "09:10"),
  health: true,
});

// Promotion to production by a human PR that pins the digest.
prMerged({
  repo: "deploy",
  number: 88,
  prId: 880088,
  merge: C.C2,
  head: C.H88,
  actor: ACTORS.erin,
  t: at(20, "14:00"),
  hints: { mentionedCommitShas: [C.A], mentionedImageDigests: [DG.DA] },
});
push({
  repo: "deploy",
  ref: "refs/heads/main",
  before: C.C1,
  head: C.C2,
  commits: [C.H88, C.C2],
  actor: ACTORS.erin,
  t: at(20, "14:00:01"),
  hints: { mentionedCommitShas: [C.A], mentionedImageDigests: [DG.DA] },
});
sync({
  app: "shop-api-production",
  env: "production",
  uid: "uid-shop-prd",
  revision: C.C2,
  historyId: 17,
  images: [`ghcr.io/acme/shop-api:${C.A}`],
  digests: [DG.DA],
  trigger: "auto_sync",
  actor: ACTORS.argocd,
  t: at(20, "14:03"),
  health: true,
});

// Commit B reaches staging only.
push({
  repo: "shop",
  ref: "refs/heads/main",
  before: C.A,
  head: C.B,
  actor: ACTORS.kim,
  t: at(21, "10:00"),
});
run({
  repo: "shop",
  runId: 9017,
  name: "build-and-bump",
  head: C.B,
  ref: "refs/heads/main",
  phase: "requested",
  event: "push",
  trigger: "push",
  actor: ACTORS.kim,
  t: at(21, "10:00:05"),
});
artifact({
  repo: "shop",
  image: "ghcr.io/acme/shop-api",
  tags: [C.B],
  digest: DG.DB,
  commit: C.B,
  runId: 9017,
  t: at(21, "10:05"),
});
push({
  repo: "deploy",
  ref: "refs/heads/main",
  before: C.C2,
  head: C.C3,
  actor: ACTORS.releaseBot,
  t: at(21, "10:06"),
  hints: { mentionedCommitShas: [C.B] },
});
run({
  repo: "shop",
  runId: 9017,
  name: "build-and-bump",
  head: C.B,
  ref: "refs/heads/main",
  phase: "completed",
  conclusion: "success",
  event: "push",
  trigger: "push",
  actor: ACTORS.kim,
  t: at(21, "10:06:30"),
});
sync({
  app: "shop-api-staging",
  env: "staging",
  uid: "uid-shop-stg",
  revision: C.C3,
  historyId: 42,
  images: [`ghcr.io/acme/shop-api:${C.B}`],
  trigger: "auto_sync",
  actor: ACTORS.argocd,
  t: at(21, "10:09"),
});

// Commit D fails CI: its journey ends there.
push({
  repo: "shop",
  ref: "refs/heads/main",
  before: C.B,
  head: C.D,
  actor: ACTORS.kim,
  t: at(21, "16:00"),
});
run({
  repo: "shop",
  runId: 9023,
  name: "build-and-bump",
  head: C.D,
  ref: "refs/heads/main",
  phase: "requested",
  event: "push",
  trigger: "push",
  actor: ACTORS.kim,
  t: at(21, "16:00:05"),
});
run({
  repo: "shop",
  runId: 9023,
  name: "build-and-bump",
  head: C.D,
  ref: "refs/heads/main",
  phase: "completed",
  conclusion: "failure",
  event: "push",
  trigger: "push",
  actor: ACTORS.kim,
  t: at(21, "16:04"),
});

// (c) Manual hotfix: image overridden on the Application, then synced by hand.
emit({
  source: "argocd",
  sourceEventId: sourceEventId("application", "uid-shop-prd", 23),
  action: "argocd.application.updated",
  actor: ACTORS.alice,
  target: {
    type: "application",
    id: "argocd/shop-api-production",
    application: "shop-api-production",
    project: "shop",
    environment: "production",
    repository: "https://github.com/acme/shop-deploy.git",
  },
  trigger: { type: "cli", sourceValue: "argocd app set --kustomize-image" },
  outcome: "none",
  occurredAt: at(22, "02:10"),
  method: "stream",
  correlation: {
    repositories: [REPO.deploy],
    environments: ["production"],
    imageRefs: ["ghcr.io/acme/shop-api:hotfix-1022"],
  },
  data: { change: "spec.source.kustomize.images", generation: 23 },
});
sync({
  app: "shop-api-production",
  env: "production",
  uid: "uid-shop-prd",
  revision: C.C2,
  historyId: 18,
  images: ["ghcr.io/acme/shop-api:hotfix-1022"],
  trigger: "manual",
  actor: ACTORS.alice,
  t: at(22, "02:11"),
});

// ===========================================================================
// (d) worker: mutable tag 1.4 rebuilt from another commit
// ===========================================================================

push({
  repo: "worker",
  ref: "refs/tags/v1.4.0",
  before: "0".repeat(40),
  head: C.W,
  actor: ACTORS.dana,
  t: at(20, "11:00"),
  created: true,
});
run({
  repo: "worker",
  runId: 9100,
  name: "release",
  head: C.W,
  ref: "refs/tags/v1.4.0",
  phase: "requested",
  event: "push",
  trigger: "tag",
  actor: ACTORS.dana,
  t: at(20, "11:00:05"),
});
artifact({
  repo: "worker",
  image: "ghcr.io/acme/worker",
  tags: ["1.4", "1.4.0"],
  digest: DG.DW1,
  commit: C.W,
  runId: 9100,
  t: at(20, "11:08"),
});
run({
  repo: "worker",
  runId: 9100,
  name: "release",
  head: C.W,
  ref: "refs/tags/v1.4.0",
  phase: "completed",
  conclusion: "success",
  event: "push",
  trigger: "tag",
  actor: ACTORS.dana,
  t: at(20, "11:09"),
});
push({
  repo: "deploy",
  ref: "refs/heads/main",
  before: C.C3,
  head: C.C4,
  actor: ACTORS.renovate,
  t: at(20, "11:30"),
});
sync({
  app: "worker-production",
  env: "production",
  uid: "uid-worker-prd",
  revision: C.C4,
  historyId: 9,
  images: ["ghcr.io/acme/worker:1.4"],
  trigger: "auto_sync",
  actor: ACTORS.argocd,
  t: at(20, "11:33"),
});

push({
  repo: "worker",
  ref: "refs/heads/release/1.4",
  before: C.W,
  head: C.W2,
  actor: ACTORS.dana,
  t: at(26, "09:00"),
});
run({
  repo: "worker",
  runId: 9188,
  name: "release",
  head: C.W2,
  ref: "refs/heads/release/1.4",
  phase: "requested",
  event: "workflow_dispatch",
  trigger: "manual",
  actor: ACTORS.erin,
  t: at(26, "09:30"),
});
artifact({
  repo: "worker",
  image: "ghcr.io/acme/worker",
  tags: ["1.4"],
  digest: DG.DW2,
  commit: C.W2,
  runId: 9188,
  t: at(26, "09:38"),
});
run({
  repo: "worker",
  runId: 9188,
  name: "release",
  head: C.W2,
  ref: "refs/heads/release/1.4",
  phase: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  trigger: "manual",
  actor: ACTORS.erin,
  t: at(26, "09:39"),
});
push({
  repo: "deploy",
  ref: "refs/heads/main",
  before: C.C4,
  head: C.C5,
  actor: ACTORS.renovate,
  t: at(26, "09:50"),
  hints: { mentionedImageDigests: [DG.DW2] },
});
sync({
  app: "worker-staging",
  env: "staging",
  uid: "uid-worker-stg",
  revision: C.C5,
  historyId: 5,
  images: ["ghcr.io/acme/worker:1.4"],
  digests: [DG.DW2],
  trigger: "auto_sync",
  actor: ACTORS.argocd,
  t: at(26, "09:53"),
});
// Restart of production: same config revision, tag 1.4 now points at the rebuild.
sync({
  app: "worker-production",
  env: "production",
  uid: "uid-worker-prd",
  revision: C.C4,
  historyId: 10,
  images: ["ghcr.io/acme/worker:1.4"],
  trigger: "manual",
  actor: ACTORS.alice,
  t: at(26, "10:15"),
});

// ===========================================================================
// (b) web: Vercel Git integration
// ===========================================================================

push({
  repo: "web",
  ref: "refs/heads/feat/checkout",
  before: C.M2,
  head: C.P1,
  actor: ACTORS.kim,
  t: at(23, "13:00"),
});
vercel({
  dpl: "dpl_p1",
  url: "web-p1abc-acme.vercel.app",
  target: "preview",
  sha: C.P1,
  ref: "refs/heads/feat/checkout",
  pr: 42,
  actor: ACTORS.vKim,
  trigger: "pull_request",
  t: at(23, "13:00:10"),
});
ghDeployment({
  id: 7001,
  statusId: 9901,
  env: "Preview – web",
  sha: C.P1,
  ref: "refs/heads/feat/checkout",
  url: "web-p1abc-acme.vercel.app",
  t: at(23, "13:00:12"),
});

prMerged({
  repo: "web",
  number: 42,
  prId: 420042,
  merge: C.M1,
  head: C.P1,
  actor: ACTORS.erin,
  t: at(23, "15:00"),
});
push({
  repo: "web",
  ref: "refs/heads/main",
  before: C.M2,
  head: C.M1,
  commits: [C.P1, C.M1],
  actor: ACTORS.erin,
  t: at(23, "15:00:01"),
});
vercel({
  dpl: "dpl_m1",
  url: "web-m1def-acme.vercel.app",
  target: "production",
  sha: C.M1,
  ref: "refs/heads/main",
  actor: ACTORS.vErin,
  trigger: "push",
  t: at(23, "15:00:10"),
});
ghDeployment({
  id: 7002,
  statusId: 9902,
  env: "Production – web",
  sha: C.M1,
  ref: "refs/heads/main",
  url: "web-m1def-acme.vercel.app",
  t: at(23, "15:00:12"),
});

push({
  repo: "web",
  ref: "refs/heads/main",
  before: C.M1,
  head: C.M2,
  actor: ACTORS.kim,
  t: at(24, "11:00"),
});
vercel({
  dpl: "dpl_m2",
  url: "web-m2ghi-acme.vercel.app",
  target: "production",
  sha: C.M2,
  ref: "refs/heads/main",
  actor: ACTORS.vKim,
  trigger: "push",
  t: at(24, "11:00:10"),
});

// Instant rollback to dpl_m1. The event names only the deployment id.
emit({
  source: "vercel",
  sourceEventId: sourceEventId("deployment", "dpl_m1", "rolled_back", at(24, "11:20")),
  action: "deployment.rolled_back",
  actor: ACTORS.vFrank,
  target: {
    type: "deployment",
    id: "dpl_m1",
    project: "web",
    environment: "production",
    repository: "acme/web",
  },
  trigger: { type: "rollback", sourceValue: "instant-rollback" },
  outcome: "succeeded",
  occurredAt: at(24, "11:20"),
  correlation: {
    repositories: [REPO.web],
    environments: ["production"],
    deploymentIds: ["vercel:dpl_m1"],
  },
  data: { replaced: "dpl_m2" },
  raw: {
    type: "deployment.rollback",
    payload: { deployment: { id: "dpl_m1" }, project: { id: "prj_web" } },
  },
});

// After a rollback, new production builds are not assigned the domains automatically.
push({
  repo: "web",
  ref: "refs/heads/main",
  before: C.M2,
  head: C.M3,
  actor: ACTORS.kim,
  t: at(24, "14:00"),
});
vercel({
  dpl: "dpl_m3",
  url: "web-m3jkl-acme.vercel.app",
  target: "production",
  sha: C.M3,
  ref: "refs/heads/main",
  actor: ACTORS.vKim,
  trigger: "push",
  t: at(24, "14:00:10"),
  aliasAssigned: false,
});
emit({
  source: "vercel",
  sourceEventId: sourceEventId("deployment", "dpl_m3", "promoted"),
  action: "deployment.promoted",
  actor: ACTORS.vFrank,
  target: {
    type: "deployment",
    id: "dpl_m3",
    project: "web",
    environment: "production",
    repository: "acme/web",
    ref: "refs/heads/main",
  },
  trigger: { type: "promotion", sourceValue: "promote" },
  outcome: "succeeded",
  occurredAt: at(24, "14:30"),
  correlation: {
    commitShas: [C.M3],
    repositories: [REPO.web],
    environments: ["production"],
    deploymentIds: ["vercel:dpl_m3"],
  },
  raw: {
    type: "deployment.promoted",
    payload: { deployment: { id: "dpl_m3", meta: { githubCommitSha: C.M3 } } },
  },
});
vercel({
  dpl: "dpl_m3r",
  url: "web-m3rmn-acme.vercel.app",
  target: "production",
  sha: C.M3,
  ref: "refs/heads/main",
  actor: ACTORS.vFrank,
  trigger: "redeploy",
  t: at(25, "09:00"),
  redeployOf: "dpl_m3",
});

push({
  repo: "web",
  ref: "refs/heads/main",
  before: C.M3,
  head: C.M4,
  actor: ACTORS.kim,
  t: at(25, "17:00"),
});
vercel({
  dpl: "dpl_m4",
  url: "web-m4opq-acme.vercel.app",
  target: "production",
  sha: C.M4,
  ref: "refs/heads/main",
  actor: ACTORS.vKim,
  trigger: "push",
  t: at(25, "17:00:10"),
});
// (c) `vercel deploy --prod` from a laptop, outside any Git checkout.
vercel({
  dpl: "dpl_cli1",
  url: "web-cli1rs-acme.vercel.app",
  target: "production",
  actor: ACTORS.vFrank,
  trigger: "cli",
  t: at(25, "18:40"),
});

// ---------------------------------------------------------------------------

/** Raw synthetic inputs (with prototype ids), in emission order. */
export const syntheticInputs: readonly Input[] = events;

/** Validated through the real schema, as correlation events (no hash chain). */
export function loadSyntheticEvents(): CorrelationEvent[] {
  return events.map(({ id, ...input }) => {
    const e = parseEventInput(input);
    return {
      id,
      source: e.source,
      action: e.action,
      actor: e.actor,
      target: e.target,
      trigger: e.trigger,
      outcome: e.outcome,
      occurredAt: e.occurredAt,
      correlation: e.correlation,
      data: e.data,
    };
  });
}
