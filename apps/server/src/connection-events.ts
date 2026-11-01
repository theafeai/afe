import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { Actor, CanonicalEventInputLike, Connection, Principal } from "@afe/core";
import { addHealthOutboxEntry, deleteHealthOutboxEntry, listHealthOutbox } from "@afe/db";
import type { ServerContext } from "./context.ts";

export function credentialOwnerOf(connection: Connection) {
  return (
    connection.config.credentialOwner ??
    (connection.source === "argocd" && typeof connection.config.account === "string"
      ? { login: connection.config.account }
      : null)
  );
}

/** The Afe caller is distinct from the account owning the source credential. */
export function applicationActor(principal: Principal): Actor {
  return { type: "user", id: principal.id, ...(principal.name ? { name: principal.name } : {}) };
}

export function lifecycleEvent(
  connection: Connection,
  action: string,
  principal: Principal | null,
): CanonicalEventInputLike {
  const at = new Date();
  return {
    source: "afe",
    sourceEventId: `connection:${connection.id}:${randomUUID()}`,
    connectionId: connection.id,
    action,
    actor: principal ? applicationActor(principal) : { type: "system", name: "Afe" },
    target: { type: "connection", id: connection.id, name: connection.name },
    trigger: { type: principal ? "manual" : "system" },
    outcome: "succeeded",
    occurredAt: at,
    observedAt: at,
    observation: { method: "internal" },
    data: {
      source: connection.source,
      actorOrigin: principal ? "afe" : "system",
      ...(credentialOwnerOf(connection) ? { credentialOwner: credentialOwnerOf(connection) } : {}),
    },
  };
}

/** Commit with the connection, then deliver after releasing its transaction. */
export async function queueLifecycleEvent(
  db: pg.Pool | pg.PoolClient,
  connection: Connection,
  input: CanonicalEventInputLike,
) {
  await addHealthOutboxEntry(db, connection.tenantId, connection.id, "event", {
    input,
    lifecycle: true,
  });
}

/** Health's scheduled outbox drain retries transient failures, including after disconnect. */
export async function flushLifecycleEvents(ctx: ServerContext, connection: Connection) {
  for (const entry of await listHealthOutbox(ctx.pool, connection.tenantId, connection.id)) {
    if (entry.kind !== "event" || entry.payload.lifecycle !== true) continue;
    try {
      await ctx.sink.ingest(entry.tenantId, entry.payload.input as CanonicalEventInputLike);
      await deleteHealthOutboxEntry(ctx.pool, entry.tenantId, entry.id);
    } catch {
      ctx.log.warn({ connectionId: connection.id }, "connection event delivery deferred");
      break;
    }
  }
}
