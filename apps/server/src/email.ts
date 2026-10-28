import { connect, isIP, type Socket } from "node:net";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { FastifyInstance } from "fastify";
import { DEFAULT_TENANT_ID } from "@afe/core";
import { createSafeLookup, validateOutboundUrl } from "@afe/core/security";
import {
  createLocalUser,
  createUserEmailLink,
  destroyEmailPayload,
  enqueueEmail,
  getCredential,
  getLocalUser,
  normalizeEmail,
  operatorPendingEmailTenants,
  purgeEmailMetadata,
  redeemUserEmailLink,
  type EmailMessage,
} from "@afe/db";
import type { ServerContext } from "./context.ts";
import type { JobDefinition } from "./jobs.ts";
import { requestTenant } from "./auth/index.ts";

/** Operator-configured SMTP. Resolve immediately before each delivery and pin the checked IP. */
export async function sendSmtpEmail(
  ctx: ServerContext,
  message: EmailMessage,
  messageId: string,
): Promise<void> {
  const smtp = ctx.config.smtp;
  if (!smtp) throw new Error("email_not_configured");
  const policy = { allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets };
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let connectDeadline: ReturnType<typeof setTimeout> | undefined;
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  try {
    await validateOutboundUrl(`https://${smtp.host}:${smtp.port}`, policy);
    const address = await new Promise<string>((resolve, reject) =>
      createSafeLookup(policy)(smtp.host, {}, (err, address) =>
        err ? reject(err) : resolve(address as string),
      ),
    );
    const options: SMTPTransport.Options = {
      getSocket: (_options, callback) => {
        socket = connect({ host: address, port: smtp.port });
        deadline = setTimeout(() => socket?.destroy(), 30_000);
        connectDeadline = setTimeout(
          () => socket?.destroy(new Error("SMTP connect timeout")),
          10_000,
        );
        const onError = (err: Error) => {
          if (connectDeadline) clearTimeout(connectDeadline);
          callback(err, {});
        };
        socket.once("error", onError);
        socket.once("connect", () => {
          if (connectDeadline) clearTimeout(connectDeadline);
          socket!.removeListener("error", onError);
          callback(null, { connection: socket! });
        });
      },
      host: address,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.allowPlaintext,
      ignoreTLS: smtp.allowPlaintext,
      tls: { ...(isIP(smtp.host) ? {} : { servername: smtp.host }) },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
      ...(smtp.username ? { auth: { user: smtp.username, pass: smtp.password!.reveal() } } : {}),
    };
    transport = nodemailer.createTransport(options);
    const result = await transport.sendMail({
      messageId: `<${messageId}@afe.local>`,
      from: smtp.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!result.accepted?.length) throw new Error("rejected");
  } catch {
    throw new Error("email_delivery_failed");
  } finally {
    if (deadline) clearTimeout(deadline);
    if (connectDeadline) clearTimeout(connectDeadline);
    socket?.destroy();
    transport?.close();
  }
}

export function emailJobs(ctx: ServerContext): JobDefinition[] {
  if (!ctx.config.smtp) return [];
  return [
    {
      name: "email.deliver",
      schedule: "* * * * *",
      handler: async () => {
        for (const tenantId of await operatorPendingEmailTenants(ctx.pool)) {
          // Row locks allow multiple workers, and prevent a duplicate concurrent send.
          for (let n = 0; n < 50; n++) {
            const db = await ctx.pool.connect();
            try {
              await db.query("BEGIN");
              const { rows } = await db.query<{
                id: string;
                credential_id: string;
                link_id: string | null;
                attempts: number;
                expired: boolean;
              }>(
                `SELECT id,credential_id,link_id,attempts,expires_at<=now() AS expired FROM email_outbox WHERE tenant_id=$1 AND state='pending' AND next_attempt_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [tenantId],
              );
              const row = rows[0];
              if (!row) {
                await db.query("COMMIT");
                break;
              }
              const valid = row.link_id
                ? (
                    await db.query(
                      `SELECT l.id FROM user_email_links l JOIN users u ON u.tenant_id=l.tenant_id AND u.id=l.user_id WHERE l.tenant_id=$1 AND l.id=$2 AND l.used_at IS NULL AND l.expires_at>now() AND NOT u.disabled AND u.credential_version=l.credential_version AND u.email=l.email`,
                      [tenantId, row.link_id],
                    )
                  ).rowCount
                : 1;
              let sent = false;
              if (!row.expired && valid) {
                const payload = await getCredential(db, ctx.keys, tenantId, row.credential_id);
                if (payload)
                  try {
                    await sendSmtpEmail(
                      ctx,
                      JSON.parse(payload.secret.reveal()) as EmailMessage,
                      row.id,
                    );
                    sent = true;
                  } catch {
                    ctx.log.warn(
                      { tenantId, outboxId: row.id, attempt: row.attempts + 1 },
                      "transactional email delivery failed",
                    );
                  }
              }
              const terminal = sent || row.expired || !valid || row.attempts >= 4;
              await db.query(
                `UPDATE email_outbox SET state=$3,attempts=attempts+1,next_attempt_at=now()+($4::integer * interval '1 second'),sent_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE tenant_id=$1 AND id=$2`,
                [
                  tenantId,
                  row.id,
                  terminal ? (sent ? "sent" : "failed") : "pending",
                  Math.min(3600, 60 * 2 ** row.attempts),
                  sent,
                ],
              );
              if (terminal) await destroyEmailPayload(db, tenantId, row.credential_id);
              await db.query("COMMIT");
            } catch {
              await db.query("ROLLBACK");
              throw new Error("email_worker_failed");
            } finally {
              db.release();
            }
          }
          await purgeEmailMetadata(ctx.pool, tenantId);
        }
      },
    },
  ];
}

export function registerEmailRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  { localAuth }: { localAuth: boolean },
) {
  const configured = Boolean(ctx.config.smtp),
    enabled = configured && localAuth;
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/account/") || req.url.startsWith("/api/admin/email"))
      reply.header("cache-control", "no-store");
    return payload;
  });
  app.get("/api/account/email", { config: { access: "public" } }, async () => ({ enabled }));
  app.get("/api/admin/email", { config: { access: "admin" } }, async (req) => ({
    enabled,
    configured,
    from: ctx.config.smtp?.from ?? null,
    deliveries: (
      await ctx.pool.query(
        `SELECT id,state,attempts,created_at,sent_at FROM email_outbox WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [requestTenant(req)],
      )
    ).rows,
  }));
  app.post<{ Body: { email?: unknown } }>(
    "/api/admin/email/test",
    { config: { access: "admin" }, bodyLimit: 4096 },
    async (req, reply) => {
      if (!configured) return reply.code(503).send({ error: "email_not_configured" });
      const email = normalizeEmail(req.body?.email);
      if (!email) return reply.code(400).send({ error: "invalid_email" });
      const db = await ctx.pool.connect();
      try {
        await db.query("BEGIN");
        await enqueueEmail(
          db,
          ctx.keys,
          requestTenant(req),
          {
            to: email,
            subject: "Afe email delivery test",
            text: "Your Afe SMTP configuration is working.",
          },
          new Date(Date.now() + 3600_000),
        );
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      } finally {
        db.release();
      }
      return reply.code(202).send({ ok: true });
    },
  );
  app.post<{ Body: { username?: unknown; email?: unknown } }>(
    "/api/admin/users/invite",
    { config: { access: "admin" }, bodyLimit: 4096 },
    async (req, reply) => {
      if (!enabled) return reply.code(503).send({ error: "email_not_configured" });
      const email = normalizeEmail(req.body?.email),
        username = req.body?.username;
      if (
        !email ||
        typeof username !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(username.trim())
      )
        return reply.code(400).send({ error: "invalid_user" });
      const db = await ctx.pool.connect(),
        tid = requestTenant(req);
      try {
        await db.query("BEGIN");
        const { user } = await createLocalUser(db, tid, username);
        await db.query(`UPDATE users SET email=$3 WHERE tenant_id=$1 AND id=$2`, [
          tid,
          user.id,
          email,
        ]);
        await createUserEmailLink(db, ctx.keys, tid, user.id, "invitation", ctx.config.publicUrl!);
        await db.query("COMMIT");
        return reply.code(201).send({ user: { ...user, email } });
      } catch (err) {
        await db.query("ROLLBACK");
        if ((err as { code?: string }).code === "23505")
          return reply.code(409).send({ error: "user_exists" });
        throw err;
      } finally {
        db.release();
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { purpose?: unknown } }>(
    "/api/admin/users/:id/email",
    { config: { access: "admin" }, bodyLimit: 4096 },
    async (req, reply) => {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      if (!(await getLocalUser(ctx.pool, requestTenant(req), req.params.id)))
        return reply.code(404).send({ error: "not_found" });
      if (!enabled) return reply.code(503).send({ error: "email_not_configured" });
      const purpose = req.body?.purpose;
      if (purpose !== "invitation" && purpose !== "reset")
        return reply.code(400).send({ error: "invalid_purpose" });
      const db = await ctx.pool.connect();
      try {
        await db.query("BEGIN");
        const id = await createUserEmailLink(
          db,
          ctx.keys,
          requestTenant(req),
          req.params.id,
          purpose,
          ctx.config.publicUrl!,
        );
        await db.query("COMMIT");
        return id
          ? reply.code(202).send({ ok: true })
          : reply.code(404).send({ error: "not_found" });
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      } finally {
        db.release();
      }
    },
  );
  // Local self-host recovery only. Hosted auth must supply its own tenant-aware recovery.
  const buckets = new Map<string, { count: number; until: number }>();
  const rateAllowed = (ip: string) => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
    if (buckets.size >= 10000 && !buckets.has(ip)) return false;
    const b = buckets.get(ip) ?? { count: 0, until: now + 15 * 60_000 };
    buckets.set(ip, b);
    return ++b.count <= 10;
  };
  app.post<{ Body: { email?: unknown } }>(
    "/api/account/reset",
    { config: { access: "public" }, bodyLimit: 4096 },
    async (req, reply) => {
      if (!enabled) return reply.code(503).send({ error: "email_not_configured" });
      if (!rateAllowed(req.ip)) return reply.code(429).send({ error: "rate_limited" });
      const email = normalizeEmail(req.body?.email);
      if (email) {
        const db = await ctx.pool.connect();
        try {
          await db.query("BEGIN");
          const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM users WHERE tenant_id=$1 AND email=$2 AND NOT disabled FOR UPDATE`,
            [DEFAULT_TENANT_ID, email],
          );
          if (rows[0]) {
            const recent = await db.query(
              `SELECT id FROM user_email_links WHERE tenant_id=$1 AND user_id=$2 AND created_at>now()-interval '15 minutes' LIMIT 1`,
              [DEFAULT_TENANT_ID, rows[0].id],
            );
            if (!recent.rowCount)
              await createUserEmailLink(
                db,
                ctx.keys,
                DEFAULT_TENANT_ID,
                rows[0].id,
                "reset",
                ctx.config.publicUrl!,
              );
          }
          await db.query("COMMIT");
        } catch {
          await db.query("ROLLBACK");
          ctx.log.warn("credential reset email could not be queued");
        } finally {
          db.release();
        }
      }
      return reply.code(202).send({ ok: true });
    },
  );
  app.post<{ Body: { token?: unknown } }>(
    "/api/account/redeem",
    { config: { access: "public" }, bodyLimit: 4096 },
    async (req, reply) => {
      if (!enabled) return reply.code(503).send({ error: "email_not_configured" });
      if (!rateAllowed(req.ip)) return reply.code(429).send({ error: "rate_limited" });
      const token =
        typeof req.body?.token === "string" && req.body.token.length <= 512
          ? await redeemUserEmailLink(ctx.pool, req.body.token)
          : null;
      return token ? { token } : reply.code(400).send({ error: "invalid_or_expired_link" });
    },
  );
}
