import { lifecycleEvent, queueLifecycleEvent, flushLifecycleEvents } from "../connection-events.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import {
  canonicalJson,
  TERRAFORM_OPERATIONS,
  type TerraformOperationInput,
  type TerraformReceipt,
  type TerraformWorkspaceView,
  type TerraformCapability,
  type TerraformRunView,
} from "@afe/core";
import { validateOutboundUrl } from "@afe/core/security";
import { getConnection, getUserToolPolicy, listConnections, upsertConnection } from "@afe/db";
import {
  executeInput,
  mutation,
  operationAvailable,
  operationInput,
  operationPermission,
  relatedId,
  remoteConnectionInput,
  runId,
  TerraformApiError,
  TerraformClient,
  terraformOrigin,
  type RemoteResource,
} from "@afe/connector-terraform";
import type { ConnectorModule, ServerContext } from "../context.ts";
import { requestTenant } from "../auth/index.ts";
import { saveAccount } from "../auth/tool-accounts.ts";
import { terraformFail as fail, terraformPolicy, terraformScope } from "./terraform-identity.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (x: unknown) => createHash("sha256").update(canonicalJson(x)).digest("hex");
type Scope = Awaited<ReturnType<typeof terraformScope>>;
type Row = {
  request_id: string;
  actor_id: string;
  connection_id: string;
  action: TerraformReceipt["action"];
  state: TerraformReceipt["state"];
  resource_key: string;
  input_digest: string;
  version: string;
  result_run_id: string | null;
  created_at: Date;
};
const messages: Record<TerraformReceipt["state"], string> = {
  requested: "Request recorded and may still be in flight. Inspect Terraform before recovery.",
  accepted: "Terraform accepted the operation. Refresh source state to observe completion.",
  rejected:
    "Terraform rejected the operation. Check permissions, rate limits and source state before a new request.",
  unknown:
    "The result is uncertain. Do not resubmit. Inspect Terraform before acknowledging possible duplicate risk.",
  released: "Duplicate risk acknowledged. A new deliberate request may be prepared.",
};
const receipt = (r: Row): TerraformReceipt => ({
  requestId: r.request_id,
  action: r.action,
  state: r.state,
  resourceKey: r.resource_key,
  resultRunId: r.result_run_id,
  createdAt: new Date(r.created_at).toISOString(),
  message: messages[r.state],
});
const root = "/api/actions/terraform/connections/:connectionId";
const resourceKey = (op: TerraformOperationInput) => (op.runId ? `run:${op.runId}` : "workspace");
const sourceUrl = (c: Scope, run?: string) =>
  `${c.config.serverUrl}/app/${encodeURIComponent(c.config.organization)}/workspaces/${encodeURIComponent(String(c.workspace.attributes.name))}${run ? `/runs/${run}` : ""}`;
const number = (x: unknown) =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;

export const terraformActionsModule: ConnectorModule = {
  source: "terraform-actions",
  routes(app, ctx) {
    const uid = (req: FastifyRequest) => {
      if (!req.principal?.localUserId)
        throw fail(403, "A named Afe user with a linked personal Terraform account is required.");
      return req.principal.localUserId;
    };
    async function scope(req: FastifyRequest<{ Params: { connectionId: string } }>) {
      const userId = uid(req);
      if (!uuid.test(req.params.connectionId)) throw fail(404, "Workspace not found.");
      return terraformScope(ctx, requestTenant(req), userId, req.params.connectionId);
    }
    async function run(c: Scope, id: string) {
      const r = await c.api.resource(`/api/v2/runs/${id}`, id, "runs");
      if (relatedId(r, "workspace") !== c.config.workspaceId)
        throw fail(404, "Run is outside this workspace.");
      return r;
    }
    async function check(c: Scope, r: RemoteResource, id: string) {
      const checks = await c.api.request(`/api/v2/runs/${r.id}/policy-checks`);
      if (
        !Array.isArray(checks.data) ||
        !checks.data.some((p) => p.id === id && p.type === "policy-checks")
      )
        throw fail(404, "Policy check is outside this run.");
      const p = await c.api.resource(`/api/v2/policy-checks/${id}`, id, "policy-checks");
      if (relatedId(p, "run") !== r.id) throw fail(404, "Policy check is outside this run.");
      return p;
    }
    function capability(
      c: Scope,
      op: TerraformOperationInput,
      r?: RemoteResource,
      p?: RemoteResource,
    ): TerraformCapability {
      const reason = !c.account.context.actionsEnabled
        ? "Enable delivery operations when linking your personal token in Profile."
        : !operationPermission(op, c.workspace, r, p)
          ? "Your Terraform user lacks the required source permission."
          : !operationAvailable(op, c.workspace, r, p)
            ? "Unavailable in the current source state."
            : null;
      return { action: op.action, enabled: reason === null, reason };
    }
    async function prepared(c: Scope, op: TerraformOperationInput) {
      const r = op.runId ? await run(c, op.runId) : undefined;
      const p = op.policyCheckId && r ? await check(c, r, op.policyCheckId) : undefined;
      const cap = capability(c, op, r, p);
      if (!cap.enabled)
        throw fail(
          operationPermission(op, c.workspace, r, p) && c.account.context.actionsEnabled
            ? 409
            : 403,
          cap.reason!,
        );
      // Bind relevant source state, exact inputs, connection and credential. Any change requires a new review.
      const state = (v?: RemoteResource) =>
        v ? { id: v.id, attributes: v.attributes, relationships: v.relationships } : null;
      return {
        version: digest([
          c.connection.id,
          c.account.credential_id,
          op,
          state(c.workspace),
          state(r),
          state(p),
        ]),
        summary: `${TERRAFORM_OPERATIONS.find(([a]) => a === op.action)![1]} · ${c.config.organization}/${String(c.workspace.attributes.name)}${op.runId ? ` · ${op.runId}` : ""}${op.policyCheckId ? ` · ${op.policyCheckId}` : ""}`,
        sourceUrl: sourceUrl(c, op.runId),
      };
    }
    function route<T>(fn: () => Promise<T>) {
      return fn().catch((error: unknown) => {
        if (error instanceof TerraformApiError)
          throw fail(
            error.status === 429
              ? 429
              : [401, 403, 404].includes(error.status)
                ? error.status
                : 502,
            error.status === 429
              ? "Terraform is rate limiting requests. Wait before refreshing."
              : "Terraform rejected access or is unavailable. Check your personal token and source state.",
          );
        if (error instanceof Error && "statusCode" in error) throw error;
        throw fail(
          502,
          "Terraform is unavailable or returned an invalid response. Refresh source state before continuing.",
        );
      });
    }
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.url.startsWith("/api/actions/terraform")) reply.header("cache-control", "no-store");
      return payload;
    });
    app.post("/api/connections/terraform/remote", { bodyLimit: 4096 }, async (req, reply) => {
      const parsed = remoteConnectionInput.safeParse(req.body);
      if (!parsed.success) throw fail(400, "Supply serverUrl, organization and workspaceId.");
      const config = parsed.data;
      try {
        config.serverUrl = terraformOrigin(config.serverUrl);
        await validateOutboundUrl(config.serverUrl, terraformPolicy(ctx));
      } catch {
        throw fail(
          400,
          "Use a permitted HTTPS Terraform server origin. Private hosts require operator configuration.",
        );
      }
      const tid = requestTenant(req);
      const db = await ctx.pool.connect();
      let connection;
      try {
        await db.query("BEGIN");
        const externalId = `remote:${config.serverUrl}:${config.workspaceId}`;
        const prior = await db.query(
          "SELECT id FROM connections WHERE tenant_id=$1 AND source='terraform' AND external_id=$2",
          [tid, externalId],
        );
        connection = await upsertConnection(db, tid, {
          source: "terraform",
          externalId,
          name: `${config.organization}/${config.workspaceId}`,
          status: "active",
          config,
        });
        await queueLifecycleEvent(
          db,
          connection,
          lifecycleEvent(
            connection,
            prior.rowCount ? "connection.updated" : "connection.created",
            req.principal!,
          ),
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
      await flushLifecycleEvents(ctx, connection);
      return reply.code(201).send({ connection });
    });
    app.post(
      "/api/profile/tools/terraform/token",
      { config: { access: "viewer" }, bodyLimit: 16384 },
      async (req) =>
        route(async () => {
          const tid = requestTenant(req),
            userId = uid(req);
          if ((await getUserToolPolicy(ctx.pool, tid, userId, "terraform")).mode !== "source")
            throw fail(403, "Terraform access is disabled.");
          const parsed = z
            .strictObject({
              token: z.string().min(10).max(8192).regex(/^\S+$/),
              connectionId: z.uuid(),
              actionsEnabled: z.boolean().default(false),
            })
            .safeParse(req.body);
          if (!parsed.success)
            throw fail(
              400,
              "Supply a personal user token, remote connectionId and actionsEnabled.",
            );
          const c = await getConnection(ctx.pool, tid, parsed.data.connectionId);
          const config = remoteConnectionInput.safeParse(c?.config);
          if (!c || c.source !== "terraform" || c.status !== "active" || !config.success)
            throw fail(404, "Active remote workspace connection not found.");
          const { Secret } = await import("@afe/core/security");
          const api = new TerraformClient(
            config.data.serverUrl,
            new Secret(parsed.data.token),
            terraformPolicy(ctx),
          );
          const identity = await api.identity();
          if (
            !/^user-[A-Za-z0-9]+$/.test(identity.id) ||
            typeof identity.attributes.username !== "string"
          )
            throw fail(
              403,
              "A personal Terraform user token is required. Team and organization tokens are not supported.",
            );
          const ws = await api.resource(
            `/api/v2/workspaces/${config.data.workspaceId}`,
            config.data.workspaceId,
            "workspaces",
          );
          if (relatedId(ws, "organization") !== config.data.organization)
            throw fail(404, "Workspace organization mismatch.");
          await saveAccount(
            ctx,
            tid,
            userId,
            "terraform",
            identity.attributes.username,
            parsed.data.token,
            {
              serverUrl: config.data.serverUrl,
              accountId: identity.id,
              actionsEnabled: parsed.data.actionsEnabled,
            },
          );
          return { ok: true };
        }),
    );
    app.get("/api/actions/terraform/resources", { config: { access: "viewer" } }, async (req) =>
      route(async () => {
        const userId = uid(req),
          tid = requestTenant(req);
        // Fail closed for missing identities instead of silently reporting an empty workspace list.
        const { terraformAccount } = await import("./terraform-identity.ts");
        await terraformAccount(ctx, tid, userId);
        const resources = [];
        for (const c of await listConnections(ctx.pool, tid)) {
          if (
            c.source !== "terraform" ||
            c.status !== "active" ||
            !remoteConnectionInput.safeParse(c.config).success
          )
            continue;
          try {
            const s = await terraformScope(ctx, tid, userId, c.id);
            resources.push({
              connectionId: c.id,
              workspaceId: s.config.workspaceId,
              name: String(s.workspace.attributes.name),
              organization: s.config.organization,
            });
          } catch (error) {
            if (
              !(error instanceof TerraformApiError && [403, 404].includes(error.status)) &&
              !(error instanceof Error && "statusCode" in error && error.statusCode === 403)
            )
              throw error;
          }
        }
        return { resources };
      }),
    );
    app.get<{ Params: { connectionId: string }; Querystring: { page?: string } }>(
      root,
      { config: { access: "viewer" } },
      async (req) =>
        route(async (): Promise<TerraformWorkspaceView> => {
          const page = Number(req.query.page ?? 1);
          if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
            throw fail(400, "Invalid page.");
          const c = await scope(req);
          const list = await c.api.request(
            `/api/v2/workspaces/${c.config.workspaceId}/runs?page[number]=${page}&page[size]=20`,
          );
          if (!Array.isArray(list.data) || list.data.length > 20)
            throw fail(502, "Invalid or oversized run page.");
          const runs: TerraformRunView[] = [];
          for (let offset = 0; offset < list.data.length; offset += 4) {
            const pageRuns = await Promise.all(
              list.data.slice(offset, offset + 4).map(async (item): Promise<TerraformRunView> => {
                if (!runId.safeParse(item.id).success) throw fail(502, "Invalid run identity.");
                const r = item;
                if (
                  r.type !== "runs" ||
                  relatedId(r, "workspace") !== c.config.workspaceId ||
                  !r.attributes
                )
                  throw fail(502, "Invalid run workspace identity.");
                const planId = relatedId(r, "plan");
                const applyId = relatedId(r, "apply");
                if (applyId && !/^apply-[A-Za-z0-9]+$/.test(applyId))
                  throw fail(502, "Invalid apply identity.");
                let plan: RemoteResource | undefined;
                if (planId) {
                  if (!/^plan-[A-Za-z0-9]+$/.test(planId))
                    throw fail(502, "Invalid plan identity.");
                  try {
                    plan = await c.api.resource(`/api/v2/plans/${planId}`, planId, "plans");
                  } catch (error) {
                    if (!(error instanceof TerraformApiError && [403, 404].includes(error.status)))
                      throw error;
                  }
                }
                const policies = await c.api.request(`/api/v2/runs/${r.id}/policy-checks`);
                if (!Array.isArray(policies.data) || policies.data.length > 100)
                  throw fail(502, "Invalid policy check list.");
                const policyViews = [];
                for (const p of policies.data) {
                  if (!/^polchk-[A-Za-z0-9]+$/.test(p.id) || relatedId(p, "run") !== r.id)
                    throw fail(502, "Invalid policy check identity.");
                  policyViews.push({
                    id: p.id,
                    status: String(p.attributes.status),
                    capabilities: [
                      capability(
                        c,
                        { action: "terraform.policy_override", runId: r.id, policyCheckId: p.id },
                        r,
                        p,
                      ),
                    ],
                  });
                }
                return {
                  id: r.id,
                  status: String(r.attributes.status),
                  url: sourceUrl(c, r.id),
                  planId: relatedId(r, "plan"),
                  applyId: relatedId(r, "apply"),
                  changes: {
                    additions: number(plan?.attributes["resource-additions"]),
                    changes: number(plan?.attributes["resource-changes"]),
                    destructions: number(plan?.attributes["resource-destructions"]),
                  },
                  capabilities: TERRAFORM_OPERATIONS.filter(([, , type]) => type === "run").map(
                    ([action]) => capability(c, { action, runId: r.id }, r),
                  ),
                  policies: policyViews,
                };
              }),
            );
            runs.push(...pageRuns);
          }
          const next = list.meta?.pagination?.["next-page"];
          return {
            context: {
              connectionId: c.connection.id,
              workspaceId: c.config.workspaceId,
              organization: c.config.organization,
              serverUrl: c.config.serverUrl,
            },
            name: String(c.workspace.attributes.name),
            locked: c.workspace.attributes.locked === true,
            url: sourceUrl(c),
            capabilities: TERRAFORM_OPERATIONS.filter(([, , type]) => type === "workspace").map(
              ([action]) => capability(c, { action }),
            ),
            runs,
            nextPage: typeof next === "number" && next === page + 1 ? next : null,
          };
        }),
    );
    app.post<{ Params: { connectionId: string } }>(
      `${root}/prepare`,
      { config: { access: "viewer" }, bodyLimit: 4096 },
      async (req) =>
        route(async () => {
          const parsed = operationInput.safeParse(req.body);
          if (!parsed.success) throw fail(400, "Invalid Terraform operation inputs.");
          return prepared(await scope(req), parsed.data);
        }),
    );
    app.get<{ Params: { connectionId: string } }>(
      `${root}/requests`,
      { config: { access: "viewer" } },
      async (req) =>
        route(async () => {
          const c = await scope(req);
          const rows = await ctx.pool.query<Row>(
            "SELECT * FROM terraform_action_requests WHERE tenant_id=$1 AND actor_id=$2 AND connection_id=$3 ORDER BY created_at DESC LIMIT 30",
            [requestTenant(req), req.principal!.id, c.connection.id],
          );
          return { requests: rows.rows.map(receipt) };
        }),
    );
    app.post<{ Params: { connectionId: string } }>(
      `${root}/execute`,
      { config: { access: "viewer" }, bodyLimit: 4096 },
      async (req, reply) =>
        route(async () => {
          const parsed = executeInput.safeParse(req.body);
          if (!parsed.success)
            throw fail(
              400,
              "Supply strict operation inputs, prepared version, UUID requestId and confirmed: true.",
            );
          const b: {
              operation: TerraformOperationInput;
              version: string;
              requestId: string;
              confirmed: true;
            } = parsed.data,
            tid = requestTenant(req),
            actor = req.principal!.id;
          let c = await scope(req);
          const r = b.operation.runId ? await run(c, b.operation.runId) : undefined;
          const p =
            b.operation.policyCheckId && r
              ? await check(c, r, b.operation.policyCheckId)
              : undefined;
          // Replays always require current policy, identity, resource and action permission.
          if (
            !c.account.context.actionsEnabled ||
            !operationPermission(b.operation, c.workspace, r, p)
          )
            throw fail(403, "Your linked Terraform user lacks permission for this operation.");
          const inputDigest = digest([b.operation, b.version]);
          const old = (
            await ctx.pool.query<Row>(
              "SELECT * FROM terraform_action_requests WHERE tenant_id=$1 AND request_id=$2",
              [tid, b.requestId],
            )
          ).rows[0];
          if (old) {
            if (
              old.actor_id !== actor ||
              old.connection_id !== c.connection.id ||
              old.input_digest !== inputDigest
            )
              throw fail(409, "Request ID was already used for another operation.");
            return receipt(old);
          }
          const plan = await prepared(c, b.operation);
          if (plan.version !== b.version)
            throw fail(409, "Terraform state changed. Refresh and review the operation again.");
          const inserted = await ctx.pool.query<Row>(
            `INSERT INTO terraform_action_requests (tenant_id,request_id,actor_id,connection_id,action,resource_key,input_digest,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *`,
            [
              tid,
              b.requestId,
              actor,
              c.connection.id,
              b.operation.action,
              resourceKey(b.operation),
              inputDigest,
              b.version,
            ],
          );
          if (!inserted.rowCount)
            throw fail(
              409,
              "This resource has a pending, uncertain or already accepted operation. Inspect request history and Terraform.",
            );
          let state: Row["state"] = "unknown",
            resultRunId: string | null = null,
            upstreamStatus: number | null = null;
          try {
            // Re-read credentials, opt-in, policy and source state after acquiring the duplicate lock.
            c = await scope(req);
            if ((await prepared(c, b.operation)).version !== b.version)
              throw fail(409, "Terraform state changed. Review again.");
          } catch (error) {
            await ctx.pool.query(
              "UPDATE terraform_action_requests SET state='rejected' WHERE tenant_id=$1 AND request_id=$2",
              [tid, b.requestId],
            );
            throw error;
          }
          const command = mutation(b.operation, c.config.workspaceId);
          try {
            const response = await c.api.request(command.path, "POST", command.body);
            state = "accepted";
            if (b.operation.action === "terraform.run" || b.operation.action === "terraform.plan") {
              const data = response.data;
              if (
                !data ||
                Array.isArray(data) ||
                data.type !== "runs" ||
                !runId.safeParse(data.id).success ||
                relatedId(data, "workspace") !== c.config.workspaceId
              )
                state = "unknown";
              else resultRunId = data.id;
            }
          } catch (error) {
            state = "unknown";
            if (error instanceof TerraformApiError) {
              upstreamStatus = error.status;
              if (error.status >= 400 && error.status < 500) state = "rejected";
              if (error.status === 429 && error.retryAfter)
                reply.header("retry-after", error.retryAfter);
            }
          }
          const updated = (
            await ctx.pool.query<Row>(
              "UPDATE terraform_action_requests SET state=$3,result_run_id=$4,upstream_status=$5 WHERE tenant_id=$1 AND request_id=$2 RETURNING *",
              [tid, b.requestId, state, resultRunId, upstreamStatus],
            )
          ).rows[0]!;
          ctx.log.info(
            {
              tenantId: tid,
              actorId: actor,
              connectionId: c.connection.id,
              workspaceId: c.config.workspaceId,
              resourceKey: resourceKey(b.operation),
              action: b.operation.action,
              requestId: b.requestId,
              state,
              upstreamStatus,
            },
            "Terraform operation outcome",
          );
          return reply
            .code(
              state === "accepted"
                ? 202
                : state === "rejected"
                  ? upstreamStatus === 429
                    ? 429
                    : 409
                  : 502,
            )
            .send(receipt(updated));
        }),
    );
    app.post<{ Params: { connectionId: string; requestId: string } }>(
      `${root}/requests/:requestId/recover`,
      { config: { access: "viewer" }, bodyLimit: 4096 },
      async (req) =>
        route(async () => {
          if (
            !uuid.test(req.params.requestId) ||
            !z
              .strictObject({
                confirmed: z.literal(true),
                acknowledgeDuplicateRisk: z.literal(true),
              })
              .safeParse(req.body).success
          )
            throw fail(400, "Explicitly confirm and acknowledge duplicate risk.");
          const c = await scope(req),
            tid = requestTenant(req);
          if (!c.account.context.actionsEnabled)
            throw fail(403, "Delivery operations are disabled.");
          const updated = await ctx.pool.query<Row>(
            "UPDATE terraform_action_requests SET state='released' WHERE tenant_id=$1 AND connection_id=$2 AND request_id=$3 AND actor_id=$4 AND (state='unknown' OR (state='requested' AND created_at < now()-interval '2 minutes')) RETURNING *",
            [tid, c.connection.id, req.params.requestId, req.principal!.id],
          );
          if (!updated.rows[0])
            throw fail(
              409,
              "Only your uncertain requests, or requests pending for two minutes, can be released.",
            );
          ctx.log.info(
            {
              tenantId: tid,
              actorId: req.principal!.id,
              connectionId: c.connection.id,
              requestId: req.params.requestId,
              state: "released",
            },
            "Terraform operation recovery",
          );
          return receipt(updated.rows[0]);
        }),
    );
  },
  jobs: (ctx: ServerContext) => [
    {
      name: "terraform-actions.purge",
      schedule: "31 * * * *",
      handler: async () => {
        // Explicit operator maintenance across tenants; deletes remain tenant-scoped.
        const tenants = await ctx.pool.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM terraform_action_requests",
        );
        for (const { tenant_id: tid } of tenants.rows) {
          const cutoff = await ctx.retention.cutoff(tid, new Date());
          if (cutoff)
            await ctx.pool.query(
              "DELETE FROM terraform_action_requests WHERE tenant_id=$1 AND created_at < $2",
              [tid, cutoff],
            );
        }
      },
    },
  ],
};
