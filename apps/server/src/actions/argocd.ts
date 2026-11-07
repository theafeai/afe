import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ARGOCD_OPERATIONS,
  argoCdOperationSchema,
  parseArgoCdOperation,
  argoCdResourceSchema,
  canonicalJson,
  type ArgoCdOperation,
  type ArgoCdApplicationChoice,
  type ArgoCdApplicationView,
  type ArgoCdOperationReceipt,
  type ArgoCdResource,
} from "@afe/core";
import {
  ArgoCdError,
  createArgoCdActionClient,
  argoCdApplicationPath,
  argoCdResourceQuery,
  argoCdPermission,
  type ArgoCdActionClient,
  type ArgoCdApplication,
} from "@afe/connector-argocd";
import { getConnection, getCredential, getLocalUser, getUserToolPolicy } from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import { toolAccounts } from "../auth/tool-accounts.ts";
import { argocdOidcConfig } from "../auth/argocd-oidc.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";
import { argocdOutboundPolicy } from "../connectors/argocd.ts";

const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const name = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/;
const digest = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
const messages = {
  requested: "Request recorded and may still be in flight. Inspect ArgoCD before recovery.",
  accepted:
    "ArgoCD accepted the request. Refresh to observe the result; acceptance is not deployment completion.",
  rejected:
    "ArgoCD rejected the request. Check permissions, rate limits and source state before preparing a new request.",
  unknown:
    "The response is uncertain. Inspect ArgoCD before explicitly acknowledging duplicate risk and recovering.",
  released: "Duplicate risk acknowledged. A new deliberate request may be prepared.",
};
type Row = {
  request_id: string;
  actor_id: string;
  action: ArgoCdOperation;
  source_permission: string;
  state: ArgoCdOperationReceipt["state"];
  input_digest: string;
  version: string;
  created_at: Date;
};
const receipt = (r: Row): ArgoCdOperationReceipt => ({
  requestId: r.request_id,
  action: r.action,
  state: r.state,
  message: messages[r.state],
  createdAt: new Date(r.created_at).toISOString(),
});
type Params = { connectionId: string; application: string };
type Query = { appNamespace?: string };
type ScopedRequest = FastifyRequest<{ Params: Params; Querystring: Query }>;
type Scope = Awaited<ReturnType<ArgoCdOperations["scope"]>>;
const active = (app: ArgoCdApplication) =>
  !!app.operation || ["Running", "Terminating"].includes(app.status?.operationState?.phase ?? "");
const resourceKey = (r: ArgoCdResource) => canonicalJson([r.group, r.kind, r.namespace, r.name]);
function resources(app: ArgoCdApplication) {
  return (app.status?.resources ?? []).flatMap((r) => {
    const parsed = argoCdResourceSchema.safeParse({
      group: r.group ?? "",
      kind: r.kind,
      namespace: r.namespace ?? "",
      name: r.name,
    });
    return parsed.success
      ? [{ ...parsed.data, status: r.status ?? "Unknown", health: r.health?.status ?? "Unknown" }]
      : [];
  });
}
function version(app: ArgoCdApplication) {
  return digest({
    uid: app.metadata?.uid,
    resourceVersion: app.metadata?.resourceVersion,
    spec: app.spec,
    operation: app.operation,
    status: app.status,
  });
}

export class ArgoCdOperations {
  constructor(
    readonly ctx: ServerContext,
    readonly clientFactory = createArgoCdActionClient,
  ) {}
  async identity(req: FastifyRequest) {
    const tid = requestTenant(req),
      uid = req.principal?.localUserId;
    if (!uid)
      throw fail(
        403,
        "Link a personal ArgoCD account in Profile. Administrator observation tokens do not grant actions.",
      );
    const user = await getLocalUser(this.ctx.pool, tid, uid);
    const policy = await getUserToolPolicy(this.ctx.pool, tid, uid, "argocd");
    if (!user || user.disabled || policy.mode !== "source")
      throw fail(403, "ArgoCD access is disabled for this account.");
    const account = (await toolAccounts(this.ctx, tid, uid)).find((a) => a.tool === "argocd");
    if (!account?.context.connectionId)
      throw fail(403, "Link your personal ArgoCD account in Profile.");
    return { tid, uid, account };
  }
  async scope(req: ScopedRequest) {
    const { connectionId, application } = req.params,
      namespace = req.query.appNamespace ?? "";
    if (
      !uuid.test(connectionId) ||
      !name.test(application) ||
      typeof namespace !== "string" ||
      (namespace !== "" && !name.test(namespace))
    )
      throw fail(400, "Select a valid connection, application and application namespace.");
    const { tid, uid, account } = await this.identity(req);
    const c = await getConnection(this.ctx.pool, tid, connectionId);
    if (!c || c.source !== "argocd" || account.context.connectionId !== c.id)
      throw fail(404, "ArgoCD application not found.");
    if (c.status !== "active") throw fail(409, "The ArgoCD connection is inactive.");
    if (c.config.mode === "agent")
      throw fail(
        409,
        "Outbound agents support observation only. Application actions require a direct connection; see the capability matrix.",
      );
    if (typeof c.config.serverUrl !== "string")
      throw fail(409, "The connection has no direct ArgoCD API endpoint.");
    if (
      account.context.oidcRevision &&
      (argocdOidcConfig(c.config.userOidc)?.revision !== account.context.oidcRevision ||
        !account.context.expiresAt ||
        account.context.expiresAt <= Date.now() / 1000)
    )
      throw fail(
        403,
        "Your ArgoCD sign-in expired or its configuration changed. Sign in again from Profile.",
      );
    const client = this.clientFactory({
      config: {
        serverUrl: c.config.serverUrl,
        caPem: typeof c.config.caPem === "string" ? c.config.caPem : undefined,
      },
      policy: argocdOutboundPolicy(this.ctx),
      token: async () => {
        const current = (await toolAccounts(this.ctx, tid, uid)).find((a) => a.tool === "argocd");
        if (
          !current ||
          current.credential_id !== account.credential_id ||
          current.context.connectionId !== c.id
        )
          throw new ArgoCdError(
            "unauthorized",
            "The linked ArgoCD account changed. Refresh before continuing.",
          );
        const token = await getCredential(this.ctx.pool, this.ctx.keys, tid, account.credential_id);
        if (!token)
          throw new ArgoCdError("unauthorized", "The linked ArgoCD credential was revoked.");
        return token.secret;
      },
    });
    try {
      const app = await client.read.getApplication(application, { appNamespace: namespace });
      if (
        app.metadata?.name !== application ||
        (app.metadata?.namespace ?? "") !== namespace ||
        !app.metadata.uid ||
        !app.metadata.resourceVersion ||
        !app.spec?.project
      )
        throw fail(
          502,
          "ArgoCD returned an invalid application identity. Select its exact namespace.",
        );
      const project = app.spec.project;
      // ArgoCD apps-in-any-namespace RBAC uses project/namespace/name.
      const object =
        namespace && namespace !== (c.config.controllerNamespace ?? "argocd")
          ? `${project}/${namespace}/${application}`
          : `${project}/${application}`;
      if (!(await client.read.canI("applications", "get", object)))
        throw fail(403, "ArgoCD application read permission is required.");
      return {
        tid,
        uid,
        c,
        account,
        client,
        app,
        project,
        object,
        namespace,
        application,
        connectionId,
      };
    } catch (e) {
      await client.close();
      throw e;
    }
  }
  context(s: Scope): ArgoCdApplicationView["context"] {
    return {
      connectionId: s.connectionId,
      connectionName: s.c.name,
      application: s.application,
      appNamespace: s.namespace,
      transport: "direct",
      uid: s.app.metadata!.uid!,
      operationId: s.app.status?.operationState?.startedAt ?? null,
    };
  }
  path(s: Scope, suffix = "", query: Record<string, string> = {}) {
    return argoCdApplicationPath(s.application, s.namespace, s.project, suffix, query);
  }
  async require(s: Scope, action: ArgoCdOperation, params: Record<string, unknown>) {
    if (s.account.context.actionsEnabled !== true)
      throw fail(
        403,
        "Enable ArgoCD actions explicitly for your linked account in this workspace.",
      );
    if (!(await s.client.read.canI("applications", argoCdPermission(action, params), s.object)))
      throw fail(403, "Your linked ArgoCD identity lacks the required source RBAC permission.");
  }
  async validate(s: Scope, action: ArgoCdOperation, p: Record<string, unknown>) {
    await this.require(s, action, p);
    if (s.app.metadata?.deletionTimestamp) throw fail(409, "This application is being deleted.");
    if (action === "argocd.terminate") {
      if (!active(s.app) || s.app.status?.operationState?.phase === "Terminating")
        throw fail(409, "There is no running operation to terminate.");
    } else if (!["argocd.refresh", "argocd.hard_refresh"].includes(action) && active(s.app))
      throw fail(
        409,
        "An operation is already running. Refresh or terminate it before continuing.",
      );
    if (action === "argocd.sync") {
      const sources = s.app.spec?.sources;
      if (sources?.length) {
        if (p.revision || (p.revisions && (p.revisions as string[]).length !== sources.length))
          throw fail(
            400,
            "Multi-source applications require one revision per source, in source order.",
          );
      } else if (p.revisions) throw fail(400, "Use revision for a single-source application.");
      for (const r of (p.resources ?? []) as ArgoCdResource[]) this.resource(s, r);
    }
    if (action === "argocd.rollback") {
      if (s.app.spec?.syncPolicy?.automated)
        throw fail(409, "Disable automatic sync before rollback.");
      if (!(s.app.status?.history ?? []).some((h) => Number(h.id) === p.id))
        throw fail(409, "The selected revision is no longer in deployment history.");
    }
    if (action === "argocd.resource_action") {
      const r = p.resource as ArgoCdResource;
      this.resource(s, r);
      const found = await s.client.request<{ actions?: { name?: string; disabled?: boolean }[] }>(
        this.path(s, "/resource/actions", argoCdResourceQuery(r)),
      );
      if (
        !found.actions?.some(
          (a) =>
            a.name === p.name &&
            a.disabled !== true &&
            !(a as { params?: unknown[] }).params?.length,
        )
      )
        throw fail(
          409,
          "The resource action is unavailable or disabled in the current source state.",
        );
    }
  }
  resource(s: Scope, r: ArgoCdResource) {
    if (!resources(s.app).some((x) => resourceKey(x) === resourceKey(r)))
      throw fail(404, "Resource is outside the selected application.");
  }
  async execute(s: Scope, action: ArgoCdOperation, p: Record<string, unknown>) {
    switch (action) {
      case "argocd.refresh":
      case "argocd.hard_refresh":
        return s.client.request(
          this.path(s, "", { refresh: action === "argocd.refresh" ? "normal" : "hard" }),
        );
      case "argocd.sync": {
        const { force, syncOptions, ...body } = p;
        return s.client.request(this.path(s, "/sync"), "POST", {
          ...body,
          syncOptions: { items: syncOptions },
          ...(p.revisions
            ? { sourcePositions: (p.revisions as string[]).map((_, i) => String(i + 1)) }
            : {}),
          name: s.application,
          appNamespace: s.namespace,
          project: s.project,
          ...(force ? { strategy: { hook: { force: true } } } : {}),
        });
      }
      case "argocd.rollback":
        return s.client.request(this.path(s, "/rollback"), "POST", {
          ...p,
          name: s.application,
          appNamespace: s.namespace,
          project: s.project,
        });
      case "argocd.terminate":
        return s.client.request(this.path(s, "/operation"), "DELETE");
      case "argocd.resource_action":
        return s.client.request(
          this.path(s, "/resource/actions", argoCdResourceQuery(p.resource as ArgoCdResource)),
          "POST",
          p.name,
        );
      case "argocd.sync_policy": {
        const policy = {
          ...s.app.spec?.syncPolicy,
          automated: p.automated
            ? { prune: p.prune, selfHeal: p.selfHeal, allowEmpty: p.allowEmpty }
            : null,
        };
        // Provider-side compare-and-swap: do not clobber concurrent GitOps edits.
        const patch = JSON.stringify([
          { op: "test", path: "/metadata/resourceVersion", value: s.app.metadata!.resourceVersion },
          { op: "add", path: "/spec/syncPolicy", value: policy },
        ]);
        return s.client.request(this.path(s), "PATCH", {
          name: s.application,
          appNamespace: s.namespace,
          project: s.project,
          patchType: "json",
          patch,
        });
      }
      case "argocd.delete":
        return s.client.request(
          this.path(s, "", {
            cascade: String(p.cascade),
            propagationPolicy: String(p.propagationPolicy),
          }),
          "DELETE",
        );
    }
  }
}

export function registerArgoCdOperations(
  app: FastifyInstance,
  ctx: ServerContext,
  clientFactory?: (options: Parameters<typeof createArgoCdActionClient>[0]) => ArgoCdActionClient,
) {
  const ops = new ArgoCdOperations(ctx, clientFactory);
  async function guarded<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && "statusCode" in e) throw e;
      if (e instanceof ArgoCdError)
        throw fail(
          e.status === 429
            ? 429
            : e.kind === "unauthorized" || e.kind === "forbidden"
              ? 403
              : e.status === 404
                ? 404
                : 502,
          e.status === 429
            ? "ArgoCD is rate limiting requests. Wait before refreshing."
            : "ArgoCD could not authorize or complete the request. Check your identity, connection and source state.",
        );
      throw fail(502, "ArgoCD is unavailable. Inspect the source state before trying again.");
    }
  }
  async function scoped<T>(req: ScopedRequest, fn: (s: Scope) => Promise<T>) {
    return guarded(async () => {
      const s = await ops.scope(req);
      try {
        return await fn(s);
      } finally {
        await s.client.close();
      }
    });
  }
  const base = "/api/actions/argocd/connections/:connectionId/applications/:application";
  app.get("/api/actions/argocd/applications", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return guarded(async () => {
      const { tid, account } = await ops.identity(req);
      const c = await getConnection(ctx.pool, tid, account.context.connectionId!);
      if (!c || c.source !== "argocd" || c.status !== "active") return { items: [] };
      if (c.config.mode === "agent")
        return {
          items: [],
          reason:
            "Outbound agents support observation only. Actions require a direct ArgoCD connection.",
        };
      // Scope performs identity/expiry/read validation for each chosen resource. Listing is read-only.
      if (
        account.context.oidcRevision &&
        (argocdOidcConfig(c.config.userOidc)?.revision !== account.context.oidcRevision ||
          !account.context.expiresAt ||
          account.context.expiresAt <= Date.now() / 1000)
      )
        throw fail(403, "Your ArgoCD sign-in expired. Sign in again from Profile.");
      const client = ops.clientFactory({
        config: {
          serverUrl: String(c.config.serverUrl),
          caPem: typeof c.config.caPem === "string" ? c.config.caPem : undefined,
        },
        policy: argocdOutboundPolicy(ctx),
        token: async () => {
          const cred = await getCredential(ctx.pool, ctx.keys, tid, account.credential_id);
          if (!cred) throw fail(403, "Your ArgoCD credential was revoked.");
          return cred.secret;
        },
      });
      try {
        const result = await client.read.listApplications();
        return {
          items: (result.items ?? []).flatMap((a) =>
            a.metadata?.name
              ? [
                  {
                    connectionId: c.id,
                    connectionName: c.name,
                    application: a.metadata.name,
                    appNamespace: a.metadata.namespace ?? "",
                    transport: "direct" as const,
                  } satisfies ArgoCdApplicationChoice,
                ]
              : [],
          ),
        };
      } finally {
        await client.close();
      }
    });
  });
  app.put<{ Body: { enabled?: unknown } }>(
    "/api/actions/argocd/consent",
    { config: { access: "viewer" }, bodyLimit: 1024 },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return guarded(async () => {
        if (
          !req.body ||
          typeof req.body.enabled !== "boolean" ||
          Object.keys(req.body).length !== 1
        )
          throw fail(400, "Supply enabled: true or false.");
        const { tid, uid } = await ops.identity(req);
        await ctx.pool.query(
          "UPDATE user_tool_accounts SET context=jsonb_set(context,'{actionsEnabled}',$3::jsonb) WHERE tenant_id=$1 AND user_id=$2 AND tool='argocd'",
          [tid, uid, JSON.stringify(req.body.enabled)],
        );
        return { enabled: req.body.enabled };
      });
    },
  );
  app.get<{ Params: Params; Querystring: Query }>(base, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return scoped(req, async (s): Promise<ArgoCdApplicationView> => ({
      context: ops.context(s),
      sourceUrl: `${String(s.c.config.serverUrl).replace(/\/$/, "")}/applications/${encodeURIComponent(s.namespace || "argocd")}/${encodeURIComponent(s.application)}`,
      sync: s.app.status?.sync?.status ?? "Unknown",
      health: s.app.status?.health?.status ?? "Unknown",
      revision:
        s.app.status?.sync?.revision ?? s.app.status?.sync?.revisions?.join(", ") ?? "Unknown",
      operation: s.app.status?.operationState?.phase ?? "None",
      actionsEnabled: s.account.context.actionsEnabled === true,
      history: (s.app.status?.history ?? []).flatMap((h) =>
        Number.isSafeInteger(Number(h.id)) && h.id !== undefined
          ? [
              {
                id: Number(h.id),
                revision: h.revision ?? h.revisions?.join(", ") ?? "Unknown",
                deployedAt: h.deployedAt ?? null,
              },
            ]
          : [],
      ),
      resources: resources(s.app),
      capabilities: await Promise.all(
        ARGOCD_OPERATIONS.map(async ([action, label, , destructive]) => {
          let reason: string | null = null;
          try {
            if (action === "argocd.resource_action") {
              if (s.account.context.actionsEnabled !== true)
                throw fail(403, "Enable ArgoCD actions for your linked account first.");
              if (!resources(s.app).length)
                throw fail(409, "No application resources are available.");
              throw fail(409, "Select a resource to discover its exact source-authorized actions.");
            } else {
              await ops.require(s, action, {});
              if (s.app.metadata?.deletionTimestamp)
                throw fail(409, "This application is being deleted.");
              if (
                action === "argocd.terminate" &&
                (!active(s.app) || s.app.status?.operationState?.phase === "Terminating")
              )
                throw fail(409, "No running operation to terminate.");
              if (
                !["argocd.refresh", "argocd.hard_refresh", "argocd.terminate"].includes(action) &&
                active(s.app)
              )
                throw fail(409, "An operation is already running.");
              if (
                action === "argocd.rollback" &&
                (s.app.spec?.syncPolicy?.automated || !s.app.status?.history?.length)
              )
                throw fail(409, "Rollback needs deployment history and automatic sync disabled.");
            }
          } catch (e) {
            if (!(e instanceof Error && "statusCode" in e)) throw e;
            reason = e.message;
          }
          return {
            action,
            label,
            destructive,
            enabled: reason === null,
            reason,
            paramsSchema: argoCdOperationSchema(action),
          };
        }),
      ),
    }));
  });
  app.get<{ Params: Params; Querystring: Query & { resource?: string } }>(
    `${base}/resource-actions`,
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return scoped(req, async (s) => {
        let r: ArgoCdResource;
        try {
          r = argoCdResourceSchema.parse(JSON.parse(req.query.resource ?? ""));
        } catch {
          throw fail(400, "Supply a valid application resource.");
        }
        ops.resource(s, r);
        const data = await s.client.request<{
          actions?: { name?: string; disabled?: boolean; params?: unknown[] }[];
        }>(ops.path(s, "/resource/actions", argoCdResourceQuery(r)));
        return {
          items: await Promise.all(
            (data.actions ?? [])
              .filter((a) => typeof a.name === "string" && name.test(a.name))
              .map(async (a) => ({
                name: a.name!,
                enabled:
                  a.disabled !== true &&
                  !a.params?.length &&
                  s.account.context.actionsEnabled === true &&
                  !active(s.app) &&
                  !s.app.metadata?.deletionTimestamp &&
                  (await s.client.read.canI(
                    "applications",
                    `action/${r.group}/${r.kind}/${a.name}`,
                    s.object,
                  )),
                reason: a.params?.length
                  ? "Parameterized resource actions are deferred; use ArgoCD."
                  : "Requires the exact source action permission and an idle application.",
              })),
          ),
        };
      });
    },
  );
  app.get<{ Params: Params; Querystring: Query }>(`${base}/diff`, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return scoped(req, async (s) => {
      const data = await s.client.request<{
        items?: {
          group?: string;
          kind?: string;
          namespace?: string;
          name?: string;
          diff?: string;
        }[];
      }>(ops.path(s, "/managed-resources"));
      return {
        items: (data.items ?? []).flatMap((r) => {
          const parsed = argoCdResourceSchema.safeParse({
            group: r.group ?? "",
            kind: r.kind,
            namespace: r.namespace ?? "",
            name: r.name,
          });
          if (!parsed.success) return [];
          return [{ ...parsed.data, changed: !!r.diff && !["{}", "null"].includes(r.diff.trim()) }];
        }),
        message:
          "Resource diff summary only. Open ArgoCD for field-level manifests; secret values are never returned by Afe.",
      };
    });
  });
  app.post<{ Params: Params; Querystring: Query; Body: { action?: unknown; params?: unknown } }>(
    `${base}/prepare`,
    { config: { access: "viewer" }, bodyLimit: 32768 },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const { action, params } = parse(req.body);
      return scoped(req, async (s) => {
        await ops.validate(s, action, params);
        return {
          action,
          version: version(s.app),
          context: ops.context(s),
          summary: `${ARGOCD_OPERATIONS.find((o) => o[0] === action)![1]}: ${s.namespace ? s.namespace + "/" : ""}${s.application}. Confirm the selected inputs; completion is observed separately.`,
        };
      });
    },
  );
  function parse(b: { action?: unknown; params?: unknown } | undefined) {
    try {
      return {
        action: b?.action as ArgoCdOperation,
        params: parseArgoCdOperation(b?.action, b?.params) as Record<string, unknown>,
      };
    } catch {
      throw fail(400, "Invalid ArgoCD action parameters. Use the capability's paramsSchema.");
    }
  }
  app.post<{
    Params: Params;
    Querystring: Query;
    Body: {
      action?: unknown;
      params?: unknown;
      version?: unknown;
      requestId?: unknown;
      confirmed?: unknown;
    };
  }>(`${base}/execute`, { config: { access: "viewer" }, bodyLimit: 32768 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body,
      { action, params } = parse(b);
    if (
      b.confirmed !== true ||
      typeof b.requestId !== "string" ||
      !uuid.test(b.requestId) ||
      typeof b.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(b.version)
    )
      throw fail(400, "Supply a prepared version, UUID requestId and confirmed: true.");
    const requestId = b.requestId,
      expected = b.version;
    return scoped(req, async (s) => {
      // Replay requires current account, resource and action authorization.
      await ops.require(s, action, params);
      const input = digest({
        connectionId: s.connectionId,
        application: s.application,
        namespace: s.namespace,
        action,
        params,
        version: expected,
      });
      const prior = (
        await ctx.pool.query<Row>(
          "SELECT * FROM argocd_action_requests WHERE tenant_id=$1 AND request_id=$2",
          [s.tid, requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.actor_id !== req.principal!.id || prior.input_digest !== input)
          throw fail(409, "Request ID belongs to another operation.");
        return receipt(prior);
      }
      await ops.validate(s, action, params);
      if (version(s.app) !== expected)
        throw fail(409, "The application changed. Refresh and prepare the operation again.");
      const lock = `${s.app.metadata!.uid}:${action === "argocd.terminate" ? "terminate" : ["argocd.refresh", "argocd.hard_refresh"].includes(action) ? "refresh" : "mutation"}`;
      const inserted = await ctx.pool.query<Row>(
        `INSERT INTO argocd_action_requests (tenant_id,request_id,actor_id,connection_id,application,app_namespace,action,input_digest,version,lock_key,source_permission)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
        [
          s.tid,
          requestId,
          req.principal!.id,
          s.connectionId,
          s.application,
          s.namespace,
          action,
          input,
          expected,
          lock,
          argoCdPermission(action, params),
        ],
      );
      if (!inserted.rowCount)
        throw fail(
          409,
          "This application already has a request for this state or an uncertain operation. Inspect request history before continuing.",
        );
      let state: Row["state"] = "unknown",
        status: number | null = null;
      try {
        await ops.execute(s, action, params);
        state = "accepted";
      } catch (e) {
        if (e instanceof ArgoCdError) {
          status = e.status ?? null;
          if (status && status >= 400 && status < 500 && status !== 408) state = "rejected";
        }
      }
      const updated = (
        await ctx.pool.query<Row>(
          "UPDATE argocd_action_requests SET state=$3,upstream_status=$4 WHERE tenant_id=$1 AND request_id=$2 RETURNING *",
          [s.tid, requestId, state, status],
        )
      ).rows[0]!;
      ctx.log.info(
        {
          tenantId: s.tid,
          actorId: req.principal!.id,
          connectionId: s.connectionId,
          application: s.application,
          appNamespace: s.namespace,
          action,
          requestId,
          state,
          upstreamStatus: status,
        },
        "ArgoCD action request",
      );
      return reply
        .code(
          state === "accepted" ? 202 : state === "rejected" ? (status === 429 ? 429 : 409) : 502,
        )
        .send(receipt(updated));
    });
  });
  app.get<{ Params: Params; Querystring: Query }>(`${base}/history`, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return scoped(req, async (s) => ({
      items: (
        await ctx.pool.query<Row>(
          "SELECT * FROM argocd_action_requests WHERE tenant_id=$1 AND connection_id=$2 AND application=$3 AND app_namespace=$4 AND actor_id=$5 ORDER BY created_at DESC LIMIT 50",
          [s.tid, s.connectionId, s.application, s.namespace, req.principal!.id],
        )
      ).rows.map(receipt),
    }));
  });
  app.post<{
    Params: Params;
    Querystring: Query;
    Body: { requestId?: unknown; acknowledgeDuplicateRisk?: unknown };
  }>(`${base}/recover`, { config: { access: "viewer" }, bodyLimit: 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (
      typeof req.body?.requestId !== "string" ||
      !uuid.test(req.body.requestId) ||
      req.body.acknowledgeDuplicateRisk !== true
    )
      throw fail(
        400,
        "Supply requestId and acknowledgeDuplicateRisk: true after inspecting ArgoCD.",
      );
    return scoped(req, async (s) => {
      const prior = (
        await ctx.pool.query<Row>(
          "SELECT * FROM argocd_action_requests WHERE tenant_id=$1 AND request_id=$2 AND actor_id=$3 AND connection_id=$4 AND application=$5 AND app_namespace=$6",
          [
            s.tid,
            req.body.requestId,
            req.principal!.id,
            s.connectionId,
            s.application,
            s.namespace,
          ],
        )
      ).rows[0];
      if (!prior) throw fail(404, "Request not found.");
      if (s.account.context.actionsEnabled !== true)
        throw fail(403, "Enable ArgoCD actions before recovery.");
      if (!(await s.client.read.canI("applications", prior.source_permission, s.object)))
        throw fail(403, "Your linked ArgoCD identity lacks the required source RBAC permission.");
      const updated = await ctx.pool.query<Row>(
        "UPDATE argocd_action_requests SET state='released',released_at=now() WHERE tenant_id=$1 AND request_id=$2 AND actor_id=$3 AND (state='unknown' OR (state='requested' AND created_at<now()-interval '2 minutes')) RETURNING *",
        [s.tid, req.body.requestId, req.principal!.id],
      );
      if (!updated.rows[0])
        throw fail(
          409,
          "Only uncertain requests, or in-flight requests older than two minutes, can be recovered.",
        );
      return receipt(updated.rows[0]);
    });
  });
}
export const argocdActionsModule: ConnectorModule = {
  source: "argocd-actions",
  routes: registerArgoCdOperations,
  jobs: (ctx) => [
    {
      name: "argocd-actions.purge",
      schedule: "31 * * * *",
      handler: async () => {
        // Explicit cross-tenant maintenance; each deletion is tenant-scoped.
        const tenants = await ctx.pool.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM argocd_action_requests",
        );
        for (const { tenant_id: tid } of tenants.rows) {
          const cutoff = await ctx.retention.cutoff(tid, new Date());
          if (cutoff)
            await ctx.pool.query(
              "DELETE FROM argocd_action_requests WHERE tenant_id=$1 AND created_at<$2",
              [tid, cutoff],
            );
        }
      },
    },
  ],
};
