import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Connection } from "@afe/core";
import { isTimestampFresh, Secret, verifyHmacSignature } from "@afe/core/security";
import {
  attachConnectionCredential,
  getConnection,
  getConnectionCredentialIds,
  getCredential,
  recordDelivery,
  resolveConnectionBySourceIdentity,
  revokeCredential,
  rotateCredential,
  setConnectionStatus,
  storeCredential,
  upsertConnection,
} from "@afe/db";
import { connectionInput, reportKey, reportSchema, terraformEvent } from "@afe/connector-terraform";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";

export const TERRAFORM_PROCESS = "terraform.process";
export const TERRAFORM_SWEEP = "terraform.sweep";
const ROLE = "reporter";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Tenant-scoped worker. Deleting a report only after sink commit makes retries safe. */
export async function processTerraformReports(
  ctx: ServerContext,
  tenantId: string,
  connectionId: string,
) {
  // Serialize workers with rotation/disconnect. NO KEY UPDATE permits the
  // event sink's FK check on its own transaction while this lock is held.
  const client = await ctx.pool.connect();
  let observedAt: Date | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM connections WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE",
      [tenantId, connectionId],
    );
    const connection = await getConnection(client, tenantId, connectionId);
    if (!connection || connection.source !== "terraform" || connection.status !== "active") {
      await client.query("ROLLBACK");
      return;
    }
    const { rows } = await client.query<{ report_key: string; body: unknown; received_at: Date }>(
      `SELECT report_key, body, received_at FROM terraform_reports
     WHERE tenant_id = $1 AND connection_id = $2 ORDER BY received_at, report_key LIMIT 100`,
      [tenantId, connectionId],
    );
    for (const row of rows) {
      const result = await ctx.sink.ingest(
        tenantId,
        terraformEvent(connection, reportSchema.parse(row.body), row.received_at),
      );
      if (result.status !== "expired") observedAt = row.received_at;
      await client.query(
        `DELETE FROM terraform_reports WHERE tenant_id = $1 AND connection_id = $2 AND report_key = $3`,
        [tenantId, connectionId, row.report_key],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (observedAt)
    await ctx.health?.reportSuccess(tenantId, connectionId, observedAt, { via: "webhook" });
}

/** Operator scheduler query across tenants, never an HTTP data-access path. */
async function sweepPendingAcrossTenants(ctx: ServerContext) {
  const { rows } = await ctx.pool.query<{ tenant_id: string; connection_id: string }>(
    `SELECT DISTINCT r.tenant_id, r.connection_id FROM terraform_reports r
     JOIN connections c ON c.tenant_id = r.tenant_id AND c.id = r.connection_id
     WHERE c.source = 'terraform' AND c.status = 'active' LIMIT 1000`,
  );
  for (const row of rows)
    await ctx.jobs.send(
      TERRAFORM_PROCESS,
      { tenantId: row.tenant_id, connectionId: row.connection_id },
      { singletonKey: `${row.tenant_id}:${row.connection_id}` },
    );
}

export function createTerraformModule(options: { now?: () => Date } = {}): ConnectorModule {
  const now = options.now ?? (() => new Date());
  return {
    source: "terraform",
    routes(app: FastifyInstance, ctx: ServerContext) {
      const locked = async (tenantId: string, id: string) => {
        const client = await ctx.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT id FROM connections WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE",
            [tenantId, id],
          );
          const connection = await getConnection(client, tenantId, id);
          if (!connection || connection.source !== "terraform") {
            await client.query("ROLLBACK");
            client.release();
            return null;
          }
          return { client, connection };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
          throw error;
        }
      };

      app.post("/api/connections/terraform", { bodyLimit: 4096 }, async (req, reply) => {
        const parsed = connectionInput.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_connection" });
        const tenantId = requestTenant(req);
        const secret = new Secret(randomBytes(32).toString("hex"));
        const client = await ctx.pool.connect();
        let connection: Connection;
        try {
          await client.query("BEGIN");
          connection = await upsertConnection(client, tenantId, {
            source: "terraform",
            externalId: randomUUID(),
            name: parsed.data.workspace,
            status: "active",
            config: parsed.data,
          });
          const credential = await storeCredential(client, ctx.keys, tenantId, {
            kind: "terraform_reporter",
            secret,
          });
          await attachConnectionCredential(client, tenantId, connection.id, ROLE, credential.id);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        return reply
          .code(201)
          .header("cache-control", "no-store")
          .send({
            connection,
            secret: secret.reveal(),
            reportPath: `/agent/terraform/v1/${connection.externalId}/reports`,
          });
      });

      app.post<{ Params: { id: string } }>(
        "/api/connections/terraform/:id/rotate-secret",
        async (req, reply) => {
          if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
          const tenantId = requestTenant(req);
          const found = await locked(tenantId, req.params.id);
          if (!found) return reply.code(404).send({ error: "not_found" });
          const { client, connection } = found;
          const secret = new Secret(randomBytes(32).toString("hex"));
          try {
            const ids = await getConnectionCredentialIds(client, tenantId, connection.id);
            if (
              connection.status !== "active" ||
              !ids[ROLE] ||
              !(await rotateCredential(client, ctx.keys, tenantId, ids[ROLE], secret))
            ) {
              await client.query("ROLLBACK");
              return reply.code(409).send({ error: "connection_inactive" });
            }
            await client.query("COMMIT");
            return reply.header("cache-control", "no-store").send({ secret: secret.reveal() });
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/connections/terraform/:id",
        async (req, reply) => {
          if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
          const tenantId = requestTenant(req);
          const found = await locked(tenantId, req.params.id);
          if (!found) return reply.code(404).send({ error: "not_found" });
          const { client, connection } = found;
          try {
            const ids = await getConnectionCredentialIds(client, tenantId, connection.id);
            if (ids[ROLE]) await revokeCredential(client, tenantId, ids[ROLE]);
            await setConnectionStatus(client, tenantId, connection.id, "disconnected");
            await client.query(
              "DELETE FROM terraform_reports WHERE tenant_id = $1 AND connection_id = $2",
              [tenantId, connection.id],
            );
            await client.query("COMMIT");
            return { note: "Reporter access revoked. Previously ingested events are retained." };
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      );

      app.post<{ Params: { identity: string } }>(
        "/agent/terraform/v1/:identity/reports",
        { config: { access: "public" }, bodyLimit: 8192 },
        async (req, reply) => {
          const unauthorized = () => reply.code(401).send({ error: "unauthorized" });
          if (!UUID.test(req.params.identity) || !req.rawBody) return unauthorized();
          const candidates = await resolveConnectionBySourceIdentity(
            ctx.pool,
            "terraform",
            req.params.identity.toLowerCase(),
          );
          if (candidates.length !== 1) return unauthorized();
          const candidate = candidates[0]!;
          const found = await locked(candidate.tenantId, candidate.id);
          if (!found) return unauthorized();
          const { client, connection } = found;
          try {
            const ids = await getConnectionCredentialIds(
              client,
              connection.tenantId,
              connection.id,
            );
            const credential = ids[ROLE]
              ? await getCredential(client, ctx.keys, connection.tenantId, ids[ROLE])
              : null;
            if (
              connection.status !== "active" ||
              !credential ||
              !verifyHmacSignature({
                payload: req.rawBody,
                secret: credential.secret,
                signature: req.headers["x-afe-signature"],
                algorithm: "sha256",
                prefix: "sha256=",
              })
            ) {
              await client.query("ROLLBACK");
              return unauthorized();
            }
            const parsed = reportSchema.safeParse(req.body);
            if (!parsed.success) {
              await client.query("ROLLBACK");
              return reply.code(400).send({ error: "invalid_report" });
            }
            const report = parsed.data;
            if (
              (report.repository &&
                report.repository.toLowerCase() !==
                  String(connection.config.repository ?? "").toLowerCase()) ||
              (report.githubRunId && !report.repository)
            ) {
              await client.query("ROLLBACK");
              return reply.code(400).send({ error: "repository_mismatch" });
            }
            const receivedAt = now();
            if (
              !isTimestampFresh(Date.parse(report.sentAt), 300_000, receivedAt.getTime()) ||
              Date.parse(report.occurredAt) > receivedAt.getTime() + 300_000
            ) {
              await client.query("ROLLBACK");
              return reply.code(401).send({ error: "stale_report" });
            }
            const key = reportKey(report);
            const fresh = await recordDelivery(
              client,
              connection.tenantId,
              "terraform",
              `${connection.externalId}:${key}`,
              receivedAt,
            );
            if (fresh) {
              const pending = await client.query<{ count: string }>(
                "SELECT count(*) FROM terraform_reports WHERE tenant_id = $1 AND connection_id = $2",
                [connection.tenantId, connection.id],
              );
              if (Number(pending.rows[0]!.count) >= 1000) {
                await client.query("ROLLBACK");
                return reply.code(429).header("retry-after", "10").send({ error: "busy" });
              }
              await client.query(
                `INSERT INTO terraform_reports (tenant_id, connection_id, report_key, received_at, body)
                VALUES ($1, $2, $3, $4, $5)`,
                [connection.tenantId, connection.id, key, receivedAt, report],
              );
            }
            await client.query("COMMIT");
            if (fresh) {
              // The scheduled sweep recovers an enqueue failure after durable acceptance.
              await ctx.jobs
                .send(
                  TERRAFORM_PROCESS,
                  { tenantId: connection.tenantId, connectionId: connection.id },
                  { singletonKey: `${connection.tenantId}:${connection.id}` },
                )
                .catch(() => {
                  ctx.log.warn(
                    { source: "terraform", connectionId: connection.id },
                    "Terraform report queued for scheduled recovery",
                  );
                });
            }
            return reply.code(fresh ? 202 : 200).send({ status: fresh ? "accepted" : "duplicate" });
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      );
    },
    jobs(ctx) {
      return [
        {
          name: TERRAFORM_PROCESS,
          handler: async (data: { tenantId?: string; connectionId?: string }) => {
            if (
              typeof data.tenantId === "string" &&
              typeof data.connectionId === "string" &&
              UUID.test(data.connectionId)
            )
              await processTerraformReports(ctx, data.tenantId, data.connectionId);
          },
        },
        {
          name: TERRAFORM_SWEEP,
          schedule: "* * * * *",
          handler: async () => sweepPendingAcrossTenants(ctx),
        },
      ];
    },
  };
}

export const terraformModule = createTerraformModule();
