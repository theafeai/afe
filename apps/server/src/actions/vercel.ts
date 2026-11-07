import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  VERCEL_OPERATIONS,
  type VercelIntent,
  type VercelOperationReceipt,
  type VercelWorkspace,
} from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  VercelActionClient,
  VercelClient,
  VercelApiError,
  VercelRateLimitError,
  parseVercelIntent,
  vercelOperationSchema,
  parseProjectSelection,
  isProjectSelected,
  sourceId,
  type VercelProject,
  type VercelDeployment,
} from "@afe/connector-vercel";
import {
  getConnection,
  getConnectionCredentialIds,
  getCredential,
  getUserToolPolicy,
  listConnections,
  revokeCredential,
  storeCredential,
} from "@afe/db";
import { toolAccounts } from "../auth/tool-accounts.ts";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const digest = (v: unknown): string =>
  createHash("sha256")
    .update(
      JSON.stringify(v, (_, x: unknown) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
          : x,
      ),
    )
    .digest("hex");
const messages = {
  requested: "Request recorded; it may still be in flight. Inspect Vercel before recovery.",
  accepted:
    "Vercel accepted the request. Refresh to check the result. Acceptance does not mean the deployment is complete.",
  rejected:
    "Vercel rejected the request. Check source permissions, rate limits and current state before a new intent.",
  unknown:
    "Outcome uncertain. Do not retry blindly. Inspect Vercel, then explicitly release the request if needed.",
  released: "Duplicate risk acknowledged; a new deliberate request can be prepared.",
};
type Receipt = {
  request_id: string;
  actor_id: string;
  connection_id: string;
  project_id: string;
  input_digest: string;
  action: VercelIntent["action"];
  state: VercelOperationReceipt["state"];
  created_at: Date;
  deployment_id: string | null;
  target_deployment_id: string | null;
  upstream_status: number | null;
};
const receipt = (r: Receipt): VercelOperationReceipt => ({
  requestId: r.request_id,
  action: r.action,
  state: r.state,
  message: messages[r.state],
  createdAt: new Date(r.created_at).toISOString(),
  upstreamStatus: r.upstream_status,
  ...(r.deployment_id ? { deploymentId: r.deployment_id } : {}),
  ...(r.target_deployment_id ? { targetDeploymentId: r.target_deployment_id } : {}),
});
type ScopeParams = { connectionId: string; projectId: string };
type Project = VercelProject & {
  autoAssignCustomDomains?: boolean;
  previewDeploymentsDisabled?: boolean;
  link?: VercelProject["link"] & { repoId?: number | string };
};
type Consent = { credential_id: string; actions: string[] };

export class VercelOperations {
  constructor(readonly ctx: ServerContext) {}
  async guarded(reply: FastifyReply, fn: () => Promise<unknown>) {
    reply.header("cache-control", "no-store");
    try {
      return await fn();
    } catch (error) {
      if (error instanceof VercelRateLimitError)
        return reply.code(429).send({
          error: "vercel_rate_limited",
          message:
            "Vercel is rate limiting requests. Wait before refreshing; mutations are never automatically retried.",
        });
      if (error instanceof VercelApiError)
        return reply.code(error.isAuthError ? 403 : error.status === 404 ? 404 : 502).send({
          error: "vercel_unavailable",
          message: error.isAuthError
            ? "Vercel denied access. Check the linked account, role and token scopes."
            : "Vercel could not provide current context. Refresh later.",
        });
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode)
        return reply
          .code(statusCode)
          .send({ error: "vercel_operation_failed", message: (error as Error).message });
      return reply.code(502).send({
        error: "vercel_unavailable",
        message: "Vercel context could not be verified. No automatic mutation retry was made.",
      });
    }
  }
  async identity(req: FastifyRequest) {
    const tid = requestTenant(req),
      uid = req.principal?.localUserId;
    if (!uid)
      throw fail(403, "Use a managed Afe user and link your personal Vercel account in Profile.");
    if ((await getUserToolPolicy(this.ctx.pool, tid, uid, "vercel")).mode !== "source")
      throw fail(403, "Vercel source access is disabled for this user.");
    const account = (await toolAccounts(this.ctx, tid, uid)).find((a) => a.tool === "vercel");
    const credential =
      account && (await getCredential(this.ctx.pool, this.ctx.keys, tid, account.credential_id));
    if (!credential || !account) throw fail(403, "Link your personal Vercel account in Profile.");
    const reader = new VercelClient({ token: credential.secret, maxRetries: 0 });
    const user = await reader.getUser();
    if (!sourceId.safeParse(user.id).success) throw fail(502, "Invalid source identity.");
    return {
      tid,
      uid,
      reader,
      user,
      readCredential: credential.secret,
      teamId: account.context.teamId ?? null,
      actorId: req.principal!.id,
    };
  }
  async scope(req: FastifyRequest, params: ScopeParams) {
    const tid = requestTenant(req);
    if (!req.principal?.localUserId)
      throw fail(403, "A managed personal Vercel identity is required.");
    if (!uuid.test(params.connectionId) || !sourceId.safeParse(params.projectId).success)
      throw fail(400, "Select a connection and project ID.");
    const connection = await getConnection(this.ctx.pool, tid, params.connectionId);
    if (!connection || connection.source !== "vercel") throw fail(404, "Connection not found.");
    if (
      connection.status !== "active" ||
      !isProjectSelected(
        parseProjectSelection(connection.config.projectSelection),
        params.projectId,
      )
    )
      throw fail(403, "The active connection must select this project.");
    const identity = await this.identity(req);
    const connectionTeam =
      typeof connection.config.teamId === "string" ? connection.config.teamId : null;
    if (
      connectionTeam !== identity.teamId ||
      (!connectionTeam && connection.config.userId !== identity.user.id)
    )
      throw fail(403, "The personal Vercel account must match the connection scope.");
    const project = (await identity.reader.getProject(
      params.projectId,
      identity.teamId,
    )) as Project;
    if (
      project.id !== params.projectId ||
      project.accountId !== (identity.teamId ?? identity.user.id)
    )
      throw fail(403, "Project is outside the linked account scope.");
    const teamSlug = identity.teamId
      ? (await identity.reader.getTeam(identity.teamId)).slug
      : identity.user.username;
    const consent = (
      await this.ctx.pool.query<Consent>(
        "SELECT credential_id,actions FROM vercel_action_credentials WHERE tenant_id=$1 AND user_id=$2 AND connection_id=$3 AND project_id=$4",
        [tid, identity.uid, params.connectionId, params.projectId],
      )
    ).rows[0];
    return { ...identity, ...params, project, consent, teamSlug };
  }
  async writer(c: Awaited<ReturnType<VercelOperations["scope"]>>, secret?: Secret<string>) {
    if (secret) {
      if (secret.reveal() === c.readCredential.reveal())
        throw fail(400, "Use a separate token from your Profile read credential.");
      const ids = await getConnectionCredentialIds(this.ctx.pool, c.tid, c.connectionId);
      const observer =
        ids.access_token &&
        (await getCredential(this.ctx.pool, this.ctx.keys, c.tid, ids.access_token));
      if (observer && secret.reveal() === observer.secret.reveal())
        throw fail(400, "The observation connection token cannot be used for actions.");
    }
    const stored =
      !secret &&
      c.consent &&
      (await getCredential(this.ctx.pool, this.ctx.keys, c.tid, c.consent.credential_id));
    if (!secret && !stored)
      throw fail(403, "Enable a separate action token for this project first.");
    const client = new VercelActionClient(
      secret ||
        (stored && stored.secret) ||
        (() => {
          throw fail(403, "Action token is unavailable.");
        })(),
    );
    const user = await client.reader.getUser();
    if (user.id !== c.user.id)
      throw fail(403, "The action token must belong to your linked Vercel identity.");
    const project = await client.reader.getProject(c.projectId, c.teamId);
    if (project.id !== c.projectId || project.accountId !== (c.teamId ?? user.id))
      throw fail(403, "Action token cannot access this project scope.");
    let role = "OWNER";
    if (c.teamId) {
      const team = await client.reader.get<{ id: string; membership?: { role?: string } }>(
        `/v2/teams/${encodeURIComponent(c.teamId)}`,
      );
      if (team.id !== c.teamId) throw fail(403, "Action token belongs to another team.");
      role = team.membership?.role ?? "";
    }
    // Conservatively deny billing/viewer/contributor and unknown roles. Provider still checks custom roles, project-level restrictions and token scopes on every mutation.
    return {
      client,
      admin: role === "OWNER",
      write: ["OWNER", "MEMBER", "DEVELOPER"].includes(role),
    };
  }
  async snapshot(c: Awaited<ReturnType<VercelOperations["scope"]>>, deploymentId?: string) {
    let deployment: VercelDeployment | null = null;
    if (deploymentId) {
      if (!sourceId.safeParse(deploymentId).success) throw fail(400, "Invalid deployment ID.");
      deployment = await c.reader.getDeployment(deploymentId, c.teamId);
      if (deployment.id !== deploymentId || deployment.projectId !== c.projectId)
        throw fail(404, "Deployment not found in this project.");
    }
    const domains = await c.reader.get<{
      domains: { name: string; verified: boolean; redirect?: string | null }[];
    }>(`/v9/projects/${c.projectId}/domains`, { teamId: c.teamId, limit: 100 });
    const aliases = deployment
      ? await c.reader.get<{
          aliases: { uid: string; alias: string }[];
          pagination?: { next?: number | null };
        }>(`/v2/deployments/${deployment.id}/aliases`, { teamId: c.teamId })
      : { aliases: [] };
    return { deployment, domains: domains.domains, aliases };
  }
  reason(
    action: VercelIntent["action"],
    c: Awaited<ReturnType<VercelOperations["scope"]>>,
    s: Awaited<ReturnType<VercelOperations["snapshot"]>>,
    writer: { write: boolean; admin: boolean } | null,
  ) {
    if (!c.consent?.actions.includes(action))
      return "Enable this operation with a separate action token for this project.";
    if (!writer?.write)
      return "A current Vercel developer or owner role and write scopes are required.";
    if (["vercel.configure", "vercel.alias_assign"].includes(action) && !writer.admin)
      return "A Vercel team owner is required for this control.";
    if (action === "vercel.deploy")
      return c.project.link?.type === "github" && c.project.link.repoId
        ? null
        : "Deploy requires a GitHub-linked Vercel project with a repository ID.";
    if (action === "vercel.configure") return null;
    const d = s.deployment;
    if (!d) return "Select a deployment first.";
    if (action === "vercel.cancel")
      return ["QUEUED", "INITIALIZING", "BUILDING"].includes(d.readyState ?? "")
        ? null
        : "Only an in-progress deployment can be cancelled.";
    if (action === "vercel.delete")
      return c.project.targets?.production?.id === d.id ||
        s.aliases.aliases.length ||
        s.aliases.pagination?.next
        ? "Move production traffic and remove aliases in Vercel before deleting this deployment."
        : ["READY", "ERROR", "CANCELED"].includes(d.readyState ?? "")
          ? null
          : "Cancel this deployment before deleting it.";
    if (action === "vercel.redeploy")
      return ["READY", "ERROR", "CANCELED"].includes(d.readyState ?? "")
        ? null
        : "Wait for this build to finish before redeploying.";
    if (d.readyState !== "READY") return "A ready deployment is required.";
    if (["vercel.promote", "vercel.rollback"].includes(action)) {
      if (d.target !== "production")
        return "Select a production deployment; preview promotion needs a rebuild.";
      if (c.project.targets?.production?.id === d.id)
        return "This deployment already serves production.";
      if (action === "vercel.rollback" && d.isRollbackCandidate !== true)
        return "Vercel must mark this deployment as a rollback candidate.";
    }
    return null;
  }
  async prepare(req: FastifyRequest, params: ScopeParams, intent: VercelIntent) {
    const c = await this.scope(req, params),
      w = await this.writer(c);
    const s = await this.snapshot(
      c,
      typeof intent.params.deploymentId === "string" ? intent.params.deploymentId : undefined,
    );
    const reason = this.reason(intent.action, c, s, w);
    if (reason) throw fail(409, reason);
    if (
      intent.action === "vercel.alias_assign" &&
      !s.domains.some((d) => d.name === intent.params.domain && d.verified && !d.redirect)
    )
      throw fail(403, "Choose an already verified, non-redirect domain attached to this project.");
    const state = {
      projectId: c.project.id,
      updatedAt: c.project.updatedAt,
      production: c.project.targets?.production?.id ?? null,
      lastAliasRequest: c.project.lastAliasRequest,
      settings: [c.project.autoAssignCustomDomains, c.project.previewDeploymentsDisabled],
      link: c.project.link,
      deployment: s.deployment && {
        id: s.deployment.id,
        state: s.deployment.readyState,
        target: s.deployment.target,
        rollback: s.deployment.isRollbackCandidate,
      },
      domains: s.domains,
      aliases: s.aliases,
    };
    return {
      c,
      w,
      prepared: {
        ...intent,
        fingerprint: digest({ intent, state }),
        context: { ...params, ...(s.deployment ? { deploymentId: s.deployment.id } : {}) },
        warning:
          intent.action === "vercel.rollback"
            ? "Changes production traffic and disables automatic production domain assignment until the next promotion. Vercel eligibility and plan restrictions still apply."
            : "Vercel checks your role and token scopes when submitted. This operation may affect delivery or production traffic. Acceptance is not completion.",
      },
    };
  }
}

export const vercelActionsModule: ConnectorModule = {
  source: "vercel-actions",
  routes(app, ctx) {
    const svc = new VercelOperations(ctx);
    const root = "/api/actions/vercel/connections/:connectionId/projects/:projectId";
    app.get("/api/actions/vercel/resources", { config: { access: "viewer" } }, (req, reply) =>
      svc.guarded(reply, async () => {
        const i = await svc.identity(req);
        const projects = await i.reader.listProjects(i.teamId, { max: 1000 });
        const connections = await listConnections(ctx.pool, i.tid, {
          source: "vercel",
          statuses: ["active"],
        });
        return {
          items: connections.flatMap((c) => {
            const team = typeof c.config.teamId === "string" ? c.config.teamId : null;
            if (team !== i.teamId || (!team && c.config.userId !== i.user.id)) return [];
            return projects
              .filter(
                (p) =>
                  p.accountId === (team ?? i.user.id) &&
                  isProjectSelected(parseProjectSelection(c.config.projectSelection), p.id),
              )
              .map((p) => ({
                connectionId: c.id,
                projectId: p.id,
                name: p.name,
                connectionName: c.name,
              }));
          }),
        };
      }),
    );
    app.get<{ Params: ScopeParams; Querystring: { deploymentId?: string; until?: string } }>(
      root,
      { config: { access: "viewer" } },
      (req, reply) =>
        svc.guarded(reply, async () => {
          const c = await svc.scope(req, req.params),
            s = await svc.snapshot(c, req.query.deploymentId);
          let w = null;
          if (c.consent) w = await svc.writer(c);
          const until = req.query.until === undefined ? undefined : Number(req.query.until);
          if (until !== undefined && (!Number.isSafeInteger(until) || until < 0))
            throw fail(400, "Invalid deployment page cursor.");
          const page = await c.reader.listDeploymentsPage({
            teamId: c.teamId,
            projectId: c.projectId,
            limit: 30,
            ...(until === undefined ? {} : { until }),
          });
          const history = (
            await ctx.pool.query<Receipt>(
              "SELECT * FROM vercel_action_requests WHERE tenant_id=$1 AND actor_id=$2 AND connection_id=$3 AND project_id=$4 ORDER BY created_at DESC LIMIT 30",
              [c.tid, c.actorId, c.connectionId, c.projectId],
            )
          ).rows.map(receipt);
          const sourceUrl = `https://vercel.com/${encodeURIComponent(c.teamSlug)}/${encodeURIComponent(c.project.name)}`;
          const deploymentUrl = (id: string) =>
            `${sourceUrl}/${encodeURIComponent(id.replace(/^dpl_/, ""))}`;
          const result: VercelWorkspace = {
            context: { ...req.params, ...(s.deployment ? { deploymentId: s.deployment.id } : {}) },
            project: {
              id: c.project.id,
              name: c.project.name,
              productionId: c.project.targets?.production?.id ?? null,
              sourceUrl,
            },
            deployments: page.deployments
              .filter((d) => d.projectId === c.projectId)
              .map((d) => ({
                id: d.uid,
                state: d.readyState ?? d.state ?? "unknown",
                target: d.target ?? "preview",
                createdAt: d.createdAt ?? d.created,
                sourceUrl: deploymentUrl(d.uid),
                commit: d.meta?.githubCommitSha ?? null,
              })),
            deployment: s.deployment
              ? {
                  id: s.deployment.id,
                  state: s.deployment.readyState ?? "unknown",
                  target: s.deployment.target ?? "preview",
                  sourceUrl: deploymentUrl(s.deployment.id),
                }
              : null,
            domains: s.domains.map((d) => ({ name: d.name, verified: d.verified })),
            settings: {
              autoAssignCustomDomains: c.project.autoAssignCustomDomains ?? null,
              previewDeploymentsDisabled: c.project.previewDeploymentsDisabled ?? null,
            },
            capabilities: VERCEL_OPERATIONS.map(([action, label]) => {
              const reason = svc.reason(action, c, s, w);
              return {
                action,
                label,
                reason,
                enabled: reason === null,
                paramsSchema: vercelOperationSchema(action),
              };
            }),
            history,
            next: page.next,
          };
          return result;
        }),
    );
    // This is user consent, never an administrator-granted custom permission. Source authority remains mandatory.
    app.put<{ Params: ScopeParams; Body: { token?: unknown; actions?: unknown } }>(
      `${root}/credential`,
      { config: { access: "viewer" }, bodyLimit: 12288 },
      (req, reply) =>
        svc.guarded(reply, async () => {
          const c = await svc.scope(req, req.params),
            b = req.body;
          if (
            !b ||
            Object.keys(b).some((k) => !["token", "actions"].includes(k)) ||
            typeof b.token !== "string" ||
            b.token.length < 8 ||
            b.token.length > 8192 ||
            /\s/.test(b.token) ||
            !Array.isArray(b.actions) ||
            !b.actions.length ||
            b.actions.length > VERCEL_OPERATIONS.length ||
            b.actions.some((a) => !VERCEL_OPERATIONS.some(([name]) => name === a))
          )
            throw fail(
              400,
              "Provide a token and an explicit nonempty list of supported operations.",
            );
          const w = await svc.writer(c, new Secret(b.token));
          if (!w.write)
            throw fail(403, "This token's current Vercel role cannot perform delivery operations.");
          const db = await ctx.pool.connect();
          try {
            await db.query("BEGIN");
            await db.query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
              c.tid,
              c.uid,
            ]);
            const old = (
              await db.query<Consent>(
                "SELECT credential_id FROM vercel_action_credentials WHERE tenant_id=$1 AND user_id=$2 AND connection_id=$3 AND project_id=$4",
                [c.tid, c.uid, c.connectionId, c.projectId],
              )
            ).rows[0];
            const cred = await storeCredential(db, ctx.keys, c.tid, {
              kind: "user_vercel_action_token",
              secret: b.token,
            });
            await db.query(
              "INSERT INTO vercel_action_credentials (tenant_id,user_id,connection_id,project_id,credential_id,actions) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,user_id,connection_id,project_id) DO UPDATE SET credential_id=EXCLUDED.credential_id,actions=EXCLUDED.actions",
              [c.tid, c.uid, c.connectionId, c.projectId, cred.id, [...new Set(b.actions)]],
            );
            if (old) await revokeCredential(db, c.tid, old.credential_id);
            await db.query("COMMIT");
          } catch (e) {
            await db.query("ROLLBACK");
            throw e;
          } finally {
            db.release();
          }
          return { ok: true };
        }),
    );
    app.delete<{ Params: ScopeParams }>(
      `${root}/credential`,
      { config: { access: "viewer" } },
      (req, reply) =>
        svc.guarded(reply, async () => {
          // Revocation works even if the provider is down or a project is deselected.
          const tid = requestTenant(req),
            uid = req.principal?.localUserId;
          if (!uid) throw fail(403, "A managed user is required.");
          if (!uuid.test(req.params.connectionId)) throw fail(400, "Invalid connection ID.");
          const old = (
            await ctx.pool.query<Consent>(
              "DELETE FROM vercel_action_credentials WHERE tenant_id=$1 AND user_id=$2 AND connection_id=$3 AND project_id=$4 RETURNING credential_id",
              [tid, uid, req.params.connectionId, req.params.projectId],
            )
          ).rows[0];
          if (old) await revokeCredential(ctx.pool, tid, old.credential_id);
          return { ok: true };
        }),
    );
    const parse = (value: unknown) => {
      try {
        return parseVercelIntent(value);
      } catch {
        throw fail(400, "Invalid operation parameters. Use the documented strict action schema.");
      }
    };
    app.post<{ Params: ScopeParams; Body: unknown }>(
      `${root}/prepare`,
      { config: { access: "viewer" }, bodyLimit: 8192 },
      (req, reply) =>
        svc.guarded(
          reply,
          async () => (await svc.prepare(req, req.params, parse(req.body))).prepared,
        ),
    );
    app.post<{
      Params: ScopeParams;
      Body: {
        action?: unknown;
        params?: unknown;
        fingerprint?: unknown;
        requestId?: unknown;
        confirmed?: unknown;
      };
    }>(root, { config: { access: "viewer" }, bodyLimit: 8192 }, (req, reply) =>
      svc.guarded(reply, async () => {
        const b = req.body;
        if (
          !b ||
          Object.keys(b).some(
            (k) => !["action", "params", "fingerprint", "requestId", "confirmed"].includes(k),
          ) ||
          b.confirmed !== true ||
          typeof b.requestId !== "string" ||
          !uuid.test(b.requestId) ||
          typeof b.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(b.fingerprint)
        )
          throw fail(
            400,
            "Supply prepared parameters, fingerprint, UUID requestId and confirmed: true.",
          );
        const intent = parse({ action: b.action, params: b.params });
        // Authorize before revealing an existing receipt, even after deletion or a state change.
        const current = await svc.scope(req, req.params),
          writer = await svc.writer(current);
        if (
          !current.consent?.actions.includes(intent.action) ||
          !writer.write ||
          (["vercel.configure", "vercel.alias_assign"].includes(intent.action) && !writer.admin)
        )
          throw fail(403, "Current source authority and project action consent are required.");
        const inputDigest = digest({ intent, fingerprint: b.fingerprint });
        const prior = (
          await ctx.pool.query<Receipt>(
            "SELECT * FROM vercel_action_requests WHERE tenant_id=$1 AND request_id=$2",
            [current.tid, b.requestId],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.actor_id !== current.actorId ||
            prior.connection_id !== current.connectionId ||
            prior.project_id !== current.projectId ||
            prior.input_digest !== inputDigest
          )
            throw fail(409, "Request ID already belongs to another intent.");
          return receipt(prior);
        }
        const { c, w, prepared } = await svc.prepare(req, req.params, intent);
        if (prepared.fingerprint !== b.fingerprint)
          throw fail(409, "Source state changed. Refresh and prepare again.");
        const inserted = await ctx.pool.query(
          "INSERT INTO vercel_action_requests (tenant_id,request_id,actor_id,connection_id,project_id,action,input_digest,lock_key,target_deployment_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING request_id",
          [
            c.tid,
            b.requestId,
            c.actorId,
            c.connectionId,
            c.projectId,
            intent.action,
            inputDigest,
            `project:${c.teamId ?? c.user.id}:${c.projectId}`,
            typeof intent.params.deploymentId === "string" ? intent.params.deploymentId : null,
          ],
        );
        if (!inserted.rowCount)
          throw fail(
            409,
            "A request is in flight or uncertain for this project. Inspect history before continuing.",
          );
        let state: VercelOperationReceipt["state"] = "unknown",
          upstreamStatus: number | null = null,
          deploymentId: string | null = null;
        try {
          let method: "POST" | "PATCH" | "DELETE" = "POST",
            path = "",
            body: unknown;
          const d = intent.params.deploymentId;
          switch (intent.action) {
            case "vercel.deploy":
              path = "/v13/deployments";
              body = {
                name: c.project.name,
                project: c.projectId,
                target: intent.params.target,
                gitSource: {
                  type: "github",
                  repoId: c.project.link!.repoId,
                  ref: intent.params.ref,
                },
              };
              break;
            case "vercel.redeploy":
              path = "/v13/deployments";
              body = {
                name: c.project.name,
                project: c.projectId,
                deploymentId: d,
                target: intent.params.target,
                withLatestCommit: false,
              };
              break;
            case "vercel.cancel":
              method = "PATCH";
              path = `/v12/deployments/${d}/cancel`;
              break;
            case "vercel.promote":
              path = `/v10/projects/${c.projectId}/promote/${d}`;
              break;
            case "vercel.rollback":
              path = `/v1/projects/${c.projectId}/rollback/${d}`;
              break;
            case "vercel.alias_assign":
              path = `/v2/deployments/${d}/aliases`;
              body = { alias: intent.params.domain };
              break;
            case "vercel.delete":
              method = "DELETE";
              path = `/v13/deployments/${d}`;
              break;
            case "vercel.configure":
              method = "PATCH";
              path = `/v9/projects/${c.projectId}`;
              body = intent.params;
              break;
          }
          const result = await w.client.mutate(method, path, c.teamId, body);
          state = "accepted";
          upstreamStatus = result.status;
          if (["vercel.deploy", "vercel.redeploy"].includes(intent.action))
            deploymentId = result.deploymentId ?? null;
        } catch (error) {
          if (error instanceof VercelApiError) {
            upstreamStatus = error.status;
            if (error.status >= 400 && error.status < 500 && error.status !== 408)
              state = "rejected";
          }
        }
        const row = (
          await ctx.pool.query<Receipt>(
            "UPDATE vercel_action_requests SET state=$3,upstream_status=$4,deployment_id=$5 WHERE tenant_id=$1 AND request_id=$2 RETURNING *",
            [c.tid, b.requestId, state, upstreamStatus, deploymentId],
          )
        ).rows[0]!;
        req.log.info(
          {
            tenantId: c.tid,
            actorId: c.actorId,
            connectionId: c.connectionId,
            projectId: c.projectId,
            requestId: b.requestId,
            action: intent.action,
            state,
            upstreamStatus,
          },
          "vercel action outcome",
        );
        return reply.code(202).send(receipt(row));
      }),
    );
    app.post<{
      Params: ScopeParams & { requestId: string };
      Body: { acknowledgeDuplicateRisk?: unknown };
    }>(
      `${root}/requests/:requestId/release`,
      { config: { access: "viewer" }, bodyLimit: 1024 },
      (req, reply) =>
        svc.guarded(reply, async () => {
          if (!uuid.test(req.params.requestId) || req.body?.acknowledgeDuplicateRisk !== true)
            throw fail(400, "Explicitly acknowledge duplicate risk.");
          const c = await svc.scope(req, req.params);
          const w = await svc.writer(c);
          const prior = (
            await ctx.pool.query<Receipt>(
              "SELECT * FROM vercel_action_requests WHERE tenant_id=$1 AND request_id=$2 AND actor_id=$3 AND connection_id=$4 AND project_id=$5",
              [c.tid, req.params.requestId, c.actorId, c.connectionId, c.projectId],
            )
          ).rows[0];
          if (
            !prior ||
            !w.write ||
            !c.consent?.actions.includes(prior.action) ||
            (["vercel.configure", "vercel.alias_assign"].includes(prior.action) && !w.admin)
          )
            throw fail(
              403,
              "Current source authority and operation consent are required for recovery.",
            );
          const row = (
            await ctx.pool.query<Receipt>(
              "UPDATE vercel_action_requests SET state='released' WHERE tenant_id=$1 AND request_id=$2 AND actor_id=$3 AND connection_id=$4 AND project_id=$5 AND (state='unknown' OR (state='requested' AND created_at < now()-interval '2 minutes')) RETURNING *",
              [c.tid, req.params.requestId, c.actorId, c.connectionId, c.projectId],
            )
          ).rows[0];
          if (!row)
            throw fail(
              409,
              "Only your uncertain request, or an in-flight request older than two minutes, can be released.",
            );
          return receipt(row);
        }),
    );
  },
  jobs: (ctx) => [
    {
      name: "vercel-actions.purge",
      schedule: "31 * * * *",
      handler: async () => {
        for (const { tenant_id: tid } of (
          await ctx.pool.query<{ tenant_id: string }>(
            "SELECT DISTINCT tenant_id FROM vercel_action_requests",
          )
        ).rows) {
          const cutoff = await ctx.retention.cutoff(tid, new Date());
          if (cutoff)
            await ctx.pool.query(
              "DELETE FROM vercel_action_requests WHERE tenant_id=$1 AND created_at<$2",
              [tid, cutoff],
            );
        }
      },
    },
  ],
};
