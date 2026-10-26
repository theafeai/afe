/**
 * Read API for connection health (AFE-13). Used by the UI (AFE-16):
 *
 *   GET /api/connections              connections with health, open gap, open alert
 *   GET /api/connections/:id/health   one connection's health, gap history, alerts
 *
 * Responses never include connection config or credentials.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  getConnectionHealth,
  listAlerts,
  listConnectionsWithHealth,
  listObservationGaps,
  type AlertRecord,
  type ConnectionWithHealth,
} from "@afe/db";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function alertView(a: AlertRecord) {
  return {
    id: a.id,
    kind: a.kind,
    message: a.message,
    gapId: a.gapId,
    blindSince: iso(a.blindSince),
    openedAt: iso(a.openedAt),
    resolvedAt: iso(a.resolvedAt),
  };
}

export function connectionHealthView(
  { connection: c, health: h }: ConnectionWithHealth,
  openAlert: AlertRecord | null,
) {
  return {
    id: c.id,
    source: c.source,
    externalId: c.externalId,
    name: c.name,
    status: c.status,
    statusReason: c.statusReason,
    createdAt: iso(c.createdAt),
    health: {
      state: h?.state ?? "unknown",
      lastSuccessAt: iso(h?.lastSuccessAt),
      lastAttemptAt: iso(h?.lastAttemptAt),
      lastFailureAt: iso(h?.lastFailureAt),
      lastErrorReason: h?.lastErrorReason ?? null,
      lastError: h?.lastError ?? null,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      nextAttemptAt: iso(h?.nextAttemptAt),
      openGap:
        h?.openGapId && h.openGapStartedAt
          ? { id: h.openGapId, startedAt: iso(h.openGapStartedAt), reason: h.openGapReason }
          : null,
      lastBackfill: h?.lastBackfillGapId
        ? {
            gapId: h.lastBackfillGapId,
            status: h.lastBackfillStatus,
            at: iso(h.lastBackfillAt),
            error: h.lastBackfillError,
          }
        : null,
    },
    alert: openAlert ? alertView(openAlert) : null,
  };
}

export function registerHealthRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  resolveTenant: (req: FastifyRequest) => string | Promise<string>,
): void {
  app.get("/api/connections", async (req) => {
    const tenantId = await resolveTenant(req);
    const [rows, open] = await Promise.all([
      listConnectionsWithHealth(pool, tenantId),
      listAlerts(pool, tenantId, { openOnly: true, limit: 1000 }),
    ]);
    const alertByConnection = new Map(open.map((a) => [a.connectionId, a]));
    return {
      connections: rows.map((r) =>
        connectionHealthView(r, alertByConnection.get(r.connection.id) ?? null),
      ),
    };
  });

  app.get<{ Params: { id: string } }>("/api/connections/:id/health", async (req, reply) => {
    const tenantId = await resolveTenant(req);
    const row = await getConnectionHealth(pool, tenantId, req.params.id);
    if (!row) return reply.code(404).send({ error: "connection not found" });
    const [gaps, alerts] = await Promise.all([
      listObservationGaps(pool, tenantId, row.connection.id),
      listAlerts(pool, tenantId, { connectionId: row.connection.id, limit: 100 }),
    ]);
    const open = alerts.find((a) => a.resolvedAt === null) ?? null;
    return {
      connection: connectionHealthView(row, open),
      gaps: gaps.map((g) => ({
        gapId: g.gapId,
        startedAt: g.startedAt,
        endedAt: g.endedAt ?? null,
        reason: g.reason,
        detail: g.detail ?? null,
        open: !g.closedEventId,
        openedEventId: g.openedEventId,
        closedEventId: g.closedEventId,
      })),
      alerts: alerts.map(alertView),
    };
  });
}
