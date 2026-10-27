/**
 * SYNTHETIC correlation workload (AFE-20) for measuring and smoke-testing the
 * correlation service. Deterministic (seeded PRNG). Every event is invented;
 * shapes follow docs/event-model.md and the AFE-15 synthetic dataset.
 *
 * Shape (defaults): 50 repositories over 30 days, three tools.
 *  - 60% GitOps services: push → workflow run (+2 jobs) → artifact.published
 *    (image `:<sha>@digest`, every 10th service also a mutable `:latest`) →
 *    bump commit in a shared deploy repo (upstreamCommitShas) → ArgoCD sync of
 *    staging (+ health); 1 in 5 commits is promoted to production by a PR
 *    pinning the digest; 1 in 10 CI runs fails; 1 in 40 production syncs is a
 *    manual image override that traces to no build.
 *  - 30% Vercel projects: preview per PR commit, production per main push
 *    (aliasAssigned), GitHub deployment mirror events (deploymentUrls), the
 *    odd instant rollback, promote and CLI deploy without Git metadata.
 *  - 10% GitHub Actions deployments to `production` (deployment + status).
 *  - A few observation gaps per connection.
 *
 * `pushesPerRepoPerDay` scales the size: ≈ 0.3 → 5k events, 1.5 → 27k,
 * 5.5 → 100k (see docs/correlation.md).
 */
import { createHash, randomUUID } from "node:crypto";
import type { CanonicalEventInputLike } from "@afe/core";
import type { CorrelationEvent } from "@afe/core/correlation";

export interface WorkloadOptions {
  repos?: number;
  days?: number;
  pushesPerRepoPerDay?: number;
  /** End of the window (default 2026-10-27T00:00:00Z). */
  end?: Date;
  seed?: number;
}

export interface Workload {
  inputs: CanonicalEventInputLike[];
  /** Time window covered. */
  from: string;
  to: string;
  /** A few commits to query journeys for. */
  sampleCommits: { repository: string; commitSha: string }[];
}

export const CONNECTIONS = {
  github: "00000000-0000-4000-8000-0000000000a1",
  argocd: "00000000-0000-4000-8000-0000000000a2",
  vercel: "00000000-0000-4000-8000-0000000000a3",
} as const;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha1 = (label: string) => createHash("sha1").update(label).digest("hex");
const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;
const MIN = 60_000;

export function generateWorkload(options: WorkloadOptions = {}): Workload {
  const repos = options.repos ?? 50;
  const days = options.days ?? 30;
  const rate = options.pushesPerRepoPerDay ?? 1.5;
  const end = (options.end ?? new Date("2026-10-27T00:00:00Z")).getTime();
  const start = end - days * 24 * 60 * MIN;
  const rnd = mulberry32(options.seed ?? 20);
  const inputs: CanonicalEventInputLike[] = [];
  const sampleCommits: Workload["sampleCommits"] = [];
  let n = 0;
  let runId = 1_000_000;
  let ghDeploymentId = 5_000_000;

  const emit = (
    t: number,
    e: Omit<
      CanonicalEventInputLike,
      "observedAt" | "observation" | "sourceEventId" | "occurredAt"
    > & {
      method?: "webhook" | "poll" | "stream";
    },
  ) => {
    if (t >= end) return;
    const { method = "webhook", ...rest } = e;
    inputs.push({
      ...rest,
      sourceEventId: `wl:${++n}`,
      occurredAt: new Date(t).toISOString(),
      observedAt: new Date(t + 1500).toISOString(),
      observation: { method },
    });
  };
  const bot = { type: "bot", login: "github-actions[bot]" } as const;
  const dev = (i: number) => ({ type: "user", login: `dev${i % 17}` }) as const;

  const deployRepos = ["github.com/acme/deploy-a", "github.com/acme/deploy-b"];
  for (let r = 0; r < repos; r++) {
    const kind = r % 10 < 6 ? "gitops" : r % 10 < 9 ? "vercel" : "actions";
    const name = `${kind === "vercel" ? "web" : "svc"}-${r}`;
    const repo = `github.com/acme/${name}`;
    const short = `acme/${name}`;
    const image = `ghcr.io/acme/${name}`;
    const mutable = kind === "gitops" && r % 10 === 0;
    const deployRepo = deployRepos[r % 2]!;
    const pushes = Math.max(1, Math.round(days * rate * (0.5 + rnd())));
    let argoHistory = 0;
    let lastProd: { sha: string; dpl: string } | null = null;
    let prevProd: { sha: string; dpl: string } | null = null;
    for (let p = 0; p < pushes; p++) {
      const t0 = start + Math.floor(rnd() * (end - start - 3 * 60 * MIN));
      const sha = sha1(`${name}:${p}`);
      const toMain = kind === "vercel" ? rnd() < 0.5 : true;
      const ref = toMain ? "refs/heads/main" : `refs/heads/feature-${p % 7}`;
      const actor = dev(p + r);
      if (sampleCommits.length < 20 && p === 3)
        sampleCommits.push({ repository: repo, commitSha: sha });
      emit(t0, {
        source: "github",
        connectionId: CONNECTIONS.github,
        action: "ref.pushed",
        actor,
        target: { type: "ref", id: `${short}:${ref}`, repository: short, ref },
        trigger: { type: "push" },
        outcome: "none",
        correlation: { commitShas: [sha], refs: [ref], repositories: [repo] },
        data: { headCommit: sha },
      });
      // CI
      const run = `github:${++runId}`;
      const failed = rnd() < 0.1;
      const ci = (dt: number, action: string, outcome: CanonicalEventInputLike["outcome"]) =>
        emit(t0 + dt, {
          source: "github",
          connectionId: CONNECTIONS.github,
          action,
          actor,
          target: { type: "workflow_run", id: `${short}:${runId}`, repository: short, ref },
          trigger: { type: "push" },
          outcome: outcome ?? "unknown",
          correlation: { commitShas: [sha], runIds: [run], refs: [ref], repositories: [repo] },
          data: {},
        });
      ci(10_000, "workflow_run.requested", "pending");
      ci(20_000, "workflow_run.in_progress", "in_progress");
      ci(4 * MIN, "workflow_job.completed", "succeeded");
      ci(6 * MIN, "workflow_job.completed", failed ? "failed" : "succeeded");
      ci(6 * MIN + 5000, "workflow_run.completed", failed ? "failed" : "succeeded");
      if (failed) continue;

      if (kind === "gitops" && toMain) {
        const dg = digest(`${name}:${p}`);
        const tags = [sha.slice(0, 7), ...(mutable ? ["latest"] : [])];
        emit(t0 + 5 * MIN, {
          source: "github",
          connectionId: CONNECTIONS.github,
          action: "artifact.published",
          actor: bot,
          target: { type: "other", id: `${image}@${dg}`, name: image, repository: short },
          trigger: { type: "upstream" },
          outcome: "none",
          correlation: {
            imageRefs: tags.map((tg) => `${image}:${tg}@${dg}`),
            imageDigests: [dg],
            commitShas: [sha],
            runIds: [run],
            repositories: [repo],
          },
          data: {},
        });
        // Bump commit in the deploy repo, then staging sync.
        const cfg = sha1(`${name}:${p}:bump`);
        emit(t0 + 7 * MIN, {
          source: "github",
          connectionId: CONNECTIONS.github,
          action: "ref.pushed",
          actor: bot,
          target: {
            type: "ref",
            id: `${deployRepo}:main`,
            repository: deployRepo.slice(11),
            ref: "refs/heads/main",
          },
          trigger: { type: "push" },
          outcome: "none",
          correlation: {
            commitShas: [cfg],
            refs: ["refs/heads/main"],
            repositories: [deployRepo],
            upstreamCommitShas: [sha],
          },
          data: { headCommit: cfg },
        });
        const sync = (
          dt: number,
          env: "staging" | "production",
          cfgSha: string,
          images: string[],
          trigger: "auto_sync" | "manual",
          who: CanonicalEventInputLike["actor"],
        ) => {
          const app = `${name}-${env}`;
          const hid = ++argoHistory;
          const base = {
            source: "argocd",
            connectionId: CONNECTIONS.argocd,
            actor: who,
            target: {
              type: "application" as const,
              id: `argocd/${app}`,
              application: app,
              namespace: `${name}-${env}`,
              environment: env,
              repository: deployRepo,
            },
            trigger: { type: trigger },
            method: "stream" as const,
          };
          const corr = {
            commitShas: [cfgSha],
            repositories: [deployRepo],
            imageRefs: images,
            environments: [env],
          };
          emit(t0 + dt, {
            ...base,
            action: "argocd.sync.started",
            outcome: "in_progress",
            correlation: corr,
            data: {},
          });
          emit(t0 + dt + 40_000, {
            ...base,
            action: "argocd.sync.succeeded",
            outcome: "succeeded",
            correlation: { ...corr, deploymentIds: [`argocd:argocd/${app}:${hid}`] },
            data: {},
          });
          emit(t0 + dt + 90_000, {
            ...base,
            action: "argocd.health.changed",
            outcome: "succeeded",
            correlation: corr,
            data: { health: "Healthy" },
          });
        };
        const stagingImage = mutable ? `${image}:latest` : `${image}:${sha.slice(0, 7)}`;
        sync(9 * MIN, "staging", cfg, [stagingImage], "auto_sync", { type: "system" });
        if (rnd() < 0.2) {
          const cfg2 = sha1(`${name}:${p}:promote`);
          const promoteAt = 60 * MIN + Math.floor(rnd() * 120 * MIN);
          emit(t0 + promoteAt, {
            source: "github",
            connectionId: CONNECTIONS.github,
            action: "pull_request.merged",
            actor: dev(p),
            target: {
              type: "repository",
              id: deployRepo,
              repository: deployRepo.slice(11),
              ref: "refs/heads/main",
            },
            trigger: { type: "pull_request" },
            outcome: "succeeded",
            correlation: {
              commitShas: [cfg2],
              repositories: [deployRepo],
              upstreamCommitShas: [sha],
              imageDigests: [dg],
            },
            data: {},
          });
          const manual = rnd() < 0.025;
          sync(
            promoteAt + 2 * MIN,
            "production",
            cfg2,
            manual ? [`${image}:hotfix-${p}`] : [`${image}:${sha.slice(0, 7)}@${dg}`],
            manual ? "manual" : "auto_sync",
            manual ? dev(p + 1) : { type: "system" },
          );
        }
      }

      if (kind === "vercel") {
        const project = `prj_${name}`;
        const dpl = `dpl_${sha.slice(0, 12)}`;
        const host = `${name}-${sha.slice(0, 9)}-acme.vercel.app`;
        const target = toMain ? "production" : "preview";
        const vt = {
          type: "project" as const,
          id: project,
          name,
          project: name,
          environment: target,
          repository: short,
          ref,
        };
        const vc = {
          commitShas: [sha],
          repositories: [repo],
          refs: [ref],
          deploymentIds: [`vercel:${dpl}`],
          deploymentUrls: [host],
          environments: [target],
        };
        emit(t0 + 30_000, {
          source: "vercel",
          connectionId: CONNECTIONS.vercel,
          action: "deployment.created",
          actor,
          target: vt,
          trigger: { type: "push" },
          outcome: "pending",
          correlation: vc,
          data: {},
        });
        emit(t0 + 3 * MIN, {
          source: "vercel",
          connectionId: CONNECTIONS.vercel,
          action: "deployment.status_updated",
          actor,
          target: vt,
          trigger: { type: "push" },
          outcome: "succeeded",
          correlation: vc,
          data: { aliasAssigned: true },
        });
        const ghEnv = `${toMain ? "Production" : "Preview"} – ${name}`;
        const gid = `github:${++ghDeploymentId}`;
        for (const [dt, action, outcome] of [
          [40_000, "deployment.created", "pending"],
          [3 * MIN + 5000, "deployment.status_updated", "succeeded"],
        ] as const) {
          emit(t0 + dt, {
            source: "github",
            connectionId: CONNECTIONS.github,
            action,
            actor: { type: "bot", login: "vercel[bot]" },
            target: {
              type: "environment",
              id: `${short}:${ghEnv}`,
              environment: ghEnv,
              repository: short,
              ref,
            },
            trigger: { type: "api" },
            outcome,
            correlation: {
              commitShas: [sha],
              repositories: [repo],
              deploymentIds: [gid],
              deploymentUrls: [host],
              environments: [ghEnv.toLowerCase()],
            },
            data: {},
          });
        }
        if (toMain) {
          prevProd = lastProd;
          lastProd = { sha, dpl };
          const roll = rnd();
          if (roll < 0.05 && prevProd) {
            emit(t0 + 30 * MIN, {
              source: "vercel",
              connectionId: CONNECTIONS.vercel,
              action: "deployment.rolled_back",
              actor: dev(p + 3),
              target: { ...vt, environment: "production" },
              trigger: { type: "rollback" },
              outcome: "succeeded",
              correlation: {
                deploymentIds: [`vercel:${prevProd.dpl}`],
                environments: ["production"],
              },
              data: {},
            });
          } else if (roll < 0.08) {
            emit(t0 + 20 * MIN, {
              source: "vercel",
              connectionId: CONNECTIONS.vercel,
              action: "deployment.status_updated",
              actor: dev(p + 5),
              target: { ...vt, environment: "production", ref: null },
              trigger: { type: "cli" },
              outcome: "succeeded",
              correlation: {
                deploymentIds: [`vercel:dpl_cli${r}x${p}`],
                repositories: [repo],
                environments: ["production"],
              },
              data: { aliasAssigned: true },
            });
          }
        }
      }

      if (kind === "actions" && toMain) {
        const gid = `github:${++ghDeploymentId}`;
        for (const [dt, action, outcome] of [
          [7 * MIN, "deployment.created", "pending"],
          [9 * MIN, "deployment.status_updated", "succeeded"],
        ] as const) {
          emit(t0 + dt, {
            source: "github",
            connectionId: CONNECTIONS.github,
            action,
            actor,
            target: {
              type: "environment",
              id: `${short}:production`,
              environment: "production",
              repository: short,
              ref,
            },
            trigger: { type: "upstream" },
            outcome,
            correlation: {
              commitShas: [sha],
              repositories: [repo],
              deploymentIds: [gid],
              runIds: [run],
              environments: ["production"],
            },
            data: {},
          });
        }
      }
    }
  }

  // Observation gaps: two per connection.
  for (const [source, connectionId] of Object.entries(CONNECTIONS)) {
    for (let g = 0; g < 2; g++) {
      const s = start + Math.floor(rnd() * (end - start - 120 * MIN));
      const e = s + (10 + Math.floor(rnd() * 90)) * MIN;
      const gap = {
        gapId: `gap-${source}-${g}`,
        connectionId,
        source,
        startedAt: new Date(s).toISOString(),
        reason: "connection_error",
        detail: null,
      };
      for (const [t, action, endedAt] of [
        [s, "observation_gap.opened", null],
        [e, "observation_gap.closed", new Date(e).toISOString()],
      ] as const) {
        emit(t, {
          source: "afe",
          connectionId,
          action,
          actor: { type: "system", id: "afe", login: "afe" },
          target: { type: "connection", id: connectionId },
          trigger: { type: "system" },
          outcome: "none",
          correlation: {},
          data: { gap: { ...gap, endedAt } },
        });
      }
    }
  }

  inputs.sort((a, b) => (String(a.occurredAt) < String(b.occurredAt) ? -1 : 1));
  return {
    inputs,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    sampleCommits,
  };
}

/** In-memory correlation events (random ids) for compute-only measurements. */
export function toCorrelationEvents(inputs: CanonicalEventInputLike[]): CorrelationEvent[] {
  return inputs.map((i) => ({
    id: randomUUID(),
    source: i.source,
    action: i.action,
    actor: i.actor,
    target: i.target,
    trigger: i.trigger,
    outcome: i.outcome ?? "unknown",
    occurredAt: String(i.occurredAt),
    correlation: i.correlation ?? {},
    data: i.data ?? {},
    connectionId: i.connectionId ?? null,
  })) as CorrelationEvent[];
}
