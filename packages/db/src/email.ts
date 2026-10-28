import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { KeyProvider } from "@afe/core/security";
import { storeCredential, revokeCredential } from "./credentials.ts";
import { issueLocalCredential } from "./users.ts";

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)
    ? email
    : null;
}
export function emailLinkDigest(token: string) {
  return createHash("sha256").update("afe-email-link-v1\0").update(token).digest("hex");
}
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Call within the transaction which creates the account action. No plaintext mail in job payloads. */
export async function enqueueEmail(
  db: pg.PoolClient,
  keys: KeyProvider,
  tenantId: string,
  message: EmailMessage,
  expiresAt: Date,
  linkId?: string,
) {
  const id = randomUUID();
  const credential = await storeCredential(db, keys, tenantId, {
    kind: "transactional_email",
    secret: JSON.stringify(message),
  });
  await db.query(
    `INSERT INTO email_outbox (tenant_id,id,credential_id,link_id,expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, id, credential.id, linkId ?? null, expiresAt],
  );
  return id;
}

/** Locks the user to serialize new links, resets, disable actions and redemption. */
export async function createUserEmailLink(
  db: pg.PoolClient,
  keys: KeyProvider,
  tenantId: string,
  userId: string,
  purpose: "invitation" | "reset",
  publicUrl: string,
) {
  const { rows } = await db.query<{ email: string; credential_version: number; disabled: boolean }>(
    `SELECT email,credential_version,disabled FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, userId],
  );
  const user = rows[0];
  if (!user?.email || user.disabled) return null;
  const id = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  const token = `afe_email.${Buffer.from(tenantId).toString("base64url")}.${id}.${secret}`;
  const expiresAt = new Date(Date.now() + (purpose === "invitation" ? 24 * 3600_000 : 30 * 60_000));
  // Resending invalidates earlier links; the worker discards their encrypted queued payloads.
  await db.query(
    `UPDATE user_email_links SET used_at=now() WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL`,
    [tenantId, userId],
  );
  await db.query(
    `INSERT INTO user_email_links (tenant_id,id,user_id,token_digest,credential_version,email,purpose,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenantId,
      id,
      userId,
      emailLinkDigest(token),
      user.credential_version,
      user.email,
      purpose,
      expiresAt,
    ],
  );
  const url = `${publicUrl}/account/accept#${token}`;
  await enqueueEmail(
    db,
    keys,
    tenantId,
    {
      to: user.email,
      subject:
        purpose === "invitation" ? "Your Afe invitation" : "Reset your Afe access credential",
      text: `${purpose === "invitation" ? "You have been invited to Afe." : "A reset of your Afe access credential was requested."}\n\nOpen this link and choose Continue to receive a new access credential:\n${url}\n\nThis link expires ${expiresAt.toISOString()} and can be used once. If you did not expect this email, ignore it. Your existing credential is unchanged until you continue.`,
    },
    expiresAt,
    id,
  );
  return id;
}

export async function redeemUserEmailLink(pool: pg.Pool, token: string) {
  const match = /^afe_email\.([A-Za-z0-9_-]{1,200})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    token,
  );
  if (!match || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(match[2]!)) return null;
  const tenantId = Buffer.from(match[1]!, "base64url").toString("utf8"),
    id = match[2]!;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Look up only by an unguessable verified token digest; token carries the tenant selector.
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM user_email_links WHERE tenant_id=$1 AND id=$2 AND token_digest=$3`,
      [tenantId, id, emailLinkDigest(token)],
    );
    if (!rows[0]) {
      await db.query("ROLLBACK");
      return null;
    }
    const userId = rows[0].user_id;
    await db.query(`SELECT id FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
      tenantId,
      userId,
    ]);
    const issued = issueLocalCredential(userId, tenantId);
    const updated = await db.query(
      `UPDATE users u SET credential_digest=$4,credential_version=u.credential_version+1 WHERE u.tenant_id=$1 AND u.id=$2 AND NOT u.disabled AND EXISTS (SELECT 1 FROM user_email_links l WHERE l.tenant_id=u.tenant_id AND l.user_id=u.id AND l.id=$3 AND l.token_digest=$5 AND l.used_at IS NULL AND l.expires_at>now() AND l.credential_version=u.credential_version AND l.email=u.email) RETURNING u.id`,
      [tenantId, userId, id, issued.digest, emailLinkDigest(token)],
    );
    if (!updated.rowCount) {
      await db.query("ROLLBACK");
      return null;
    }
    await db.query(
      `UPDATE user_email_links SET used_at=now() WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL`,
      [tenantId, userId],
    );
    await db.query("COMMIT");
    return issued.token;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/** Operator maintenance: discovers tenant-scoped pending outboxes for the worker. */
export async function operatorPendingEmailTenants(pool: pg.Pool) {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM email_outbox WHERE (state='pending' AND next_attempt_at<=now()) OR expires_at<now()-interval '7 days' LIMIT 1000`,
  );
  return rows.map((r) => r.tenant_id);
}

export async function destroyEmailPayload(
  db: pg.PoolClient,
  tenantId: string,
  credentialId: string,
) {
  await revokeCredential(db, tenantId, credentialId);
}

/** Operator worker maintenance after delivery. Retain account-action metadata for at most seven days past expiry. */
export async function purgeEmailMetadata(pool: pg.Pool, tenantId: string) {
  await pool.query(
    `DELETE FROM email_outbox WHERE tenant_id=$1 AND state<>'pending' AND expires_at<now()-interval '7 days'`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM user_email_links l WHERE l.tenant_id=$1 AND l.expires_at<now()-interval '7 days' AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.tenant_id=l.tenant_id AND o.link_id=l.id)`,
    [tenantId],
  );
}
