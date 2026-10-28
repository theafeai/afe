/**
 * Drift API (AFE-26). Reads are viewer access, changing settings is admin
 * (ADR 0006); the tenant is always `requestTenant(req)`. Reference:
 * docs/api.md "Drift findings".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DRIFT_FINDING_TYPES,
  DRIFT_SEVERITIES,
  DEFAULT_DRIFT_SEVERITY,
  DRIFT_TYPE_PATTERN,
  isDriftSeverity,
  severityRank,
  type DriftSeverity,
} from "@afe/core/drift";
import {
  countDriftFindings,
  existingEventIds,
  getDriftFinding,
  listDriftFindings,
  putDriftSettings,
  type DriftFindingRecord,
  type ListDriftFindingsOptions,
} from "@afe/db";
import { requestEventAccess } from "../auth/permissions.ts";
import { requestTenant } from "../auth/index.ts";
import { UNMAPPED } from "../correlation/views.ts";
import type { DriftService, EvaluationSummary } from "./service.ts";

class BadRequest extends Error {}
class NotFound extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^(?:[a-z0-9][a-z0-9_-]{0,63}|_unmapped)$/;

function single(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) throw new BadRequest(`${key} may only be given once`);
  return String(v);
}

function list(q: Record<string, unknown>, key: string, allowed: readonly string[] | RegExp) {
  const raw = single(q, key);
  if (raw === undefined) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const i of items) {
    const ok = Array.isArray(allowed) ? allowed.includes(i) : (allowed as RegExp).test(i);
    if (!ok) throw new BadRequest(`invalid ${key} ${JSON.stringify(i.slice(0, 64))}`);
  }
  return items;
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof BadRequest)
    return reply.code(400).send({ error: "bad_request", message: err.message });
  if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
  throw err;
}

function encodeCursor(f: DriftFindingRecord): string {
  return Buffer.from(JSON.stringify({ v: 1, a: f.lastSeenAt.toISOString(), i: f.id })).toString(
    "base64url",
  );
}
function decodeCursor(c: string): { lastSeenAt: string; id: string } {
  try {
    if (c.length > 256 || !/^[A-Za-z0-9_-]+$/.test(c)) throw new Error();
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as Record<string, unknown>;
    if (o.v !== 1 || typeof o.a !== "string" || typeof o.i !== "string" || !UUID.test(o.i))
      throw new Error();
    if (Number.isNaN(Date.parse(o.a))) throw new Error();
    return { lastSeenAt: o.a, id: o.i };
  } catch {
    throw new BadRequest("invalid cursor");
  }
}

export interface FindingSummaryView {
  id: string;
  type: string;
  severity: string;
  status: "open" | "resolved";
  title: string;
  explanation: string;
  target: { key: string; source: string; label: string; toolEnvironment: string };
  service: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  openingEventId: string;
  resolvedByEventId: string | null;
  evidenceCount: number;
  url: string;
}

function summaryView(f: DriftFindingRecord): FindingSummaryView {
  return {
    id: f.id,
    type: f.type,
    severity: f.severity,
    status: f.status,
    title: f.title,
    explanation: f.explanation,
    target: {
      key: f.targetKey,
      source: f.targetSource,
      label: f.targetLabel,
      toolEnvironment: f.toolEnvironment,
    },
    service: f.serviceId ? { id: f.serviceId, name: f.serviceName ?? f.serviceId } : null,
    environment: f.environmentId
      ? { id: f.environmentId, name: f.environmentName ?? f.environmentId }
      : null,
    firstSeenAt: f.firstSeenAt.toISOString(),
    lastSeenAt: f.lastSeenAt.toISOString(),
    resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
    openingEventId: f.openingEventId,
    resolvedByEventId: f.resolvedByEventId,
    evidenceCount: f.evidence.length + f.evidenceOmitted,
    url: `/api/drift/findings/${f.id}`,
  };
}

/** Commits named in a finding's details, for journey links. */
function commitsOf(details: unknown): { repository: string; commitSha: string }[] {
  const out = new Map<string, { repository: string; commitSha: string }>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.commitSha === "string" && typeof o.repository === "string")
      out.set(`${o.repository}@${o.commitSha}`, {
        repository: o.repository,
        commitSha: o.commitSha,
      });
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(details, 0);
  return [...out.values()].slice(0, 10);
}

const maxSeverity = (a: string | null, b: string): string =>
  !a || severityRank(b as DriftSeverity) > severityRank(a as DriftSeverity) ? b : a;

export function registerDriftRoutes(app: FastifyInstance, service: DriftService) {
  const query = (req: FastifyRequest, allowed: readonly string[]) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(q))
      if (!allowed.includes(k))
        throw new BadRequest(`unknown parameter ${JSON.stringify(k.slice(0, 64))}`);
    return q;
  };
  /** Brings findings up to date with the correlation window (cheap when nothing changed). */
  const fresh = async (tenantId: string): Promise<EvaluationSummary | null> => {
    try {
      return await service.ensureFresh(tenantId);
    } catch (err) {
      // Reads still answer from the stored findings.
      service.ctx.log.warn({ tenantId, err: String(err) }, "drift: evaluation on read failed");
      return null;
    }
  };
  const dim = (v: string | undefined) => (v === undefined ? undefined : v === UNMAPPED ? null : v);

  app.get("/api/drift/findings", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const q = query(req, [
        "status",
        "type",
        "severity",
        "service",
        "environment",
        "target",
        "limit",
        "cursor",
      ]);
      const status = single(q, "status") ?? "all";
      if (!["open", "resolved", "all"].includes(status))
        throw new BadRequest("status must be open, resolved or all");
      const types = list(q, "type", DRIFT_TYPE_PATTERN);
      const severities = list(q, "severity", DRIFT_SEVERITIES);
      const svc = single(q, "service");
      const env = single(q, "environment");
      for (const [k, v] of [
        ["service", svc],
        ["environment", env],
      ] as const)
        if (v !== undefined && !SLUG.test(v))
          throw new BadRequest(`invalid ${k} ${JSON.stringify(v.slice(0, 64))}`);
      const target = single(q, "target");
      if (target !== undefined && (target.length < 1 || target.length > 1024))
        throw new BadRequest("invalid target");
      const limitRaw = single(q, "limit");
      const limit = limitRaw === undefined ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new BadRequest("limit must be an integer from 1 to 200");
      const cursorRaw = single(q, "cursor");
      const before = cursorRaw ? decodeCursor(cursorRaw) : undefined;

      const evaluation = await fresh(tenantId);
      const access = await requestEventAccess(service.pool, req, service.ctx);
      const filter: ListDriftFindingsOptions = {
        access,
        ...(types ? { types } : {}),
        ...(severities ? { severities } : {}),
        ...(svc !== undefined ? { service: dim(svc) ?? null } : {}),
        ...(env !== undefined ? { environment: dim(env) ?? null } : {}),
        ...(target ? { targetKey: target } : {}),
      };
      const [rows, counts] = await Promise.all([
        listDriftFindings(service.pool, tenantId, {
          ...filter,
          ...(status !== "all" ? { status: status as "open" | "resolved" } : {}),
          ...(before ? { before } : {}),
          limit: limit + 1,
        }),
        // Counts per status, with the other filters.
        countDriftFindings(service.pool, tenantId, filter),
      ]);
      const page = rows.slice(0, limit);
      const total = { open: 0, resolved: 0 };
      for (const c of counts) total[c.status as "open" | "resolved"] += c.count;
      return {
        evaluatedAt: evaluation?.evaluatedAt ?? null,
        counts: total,
        findings: page.map(summaryView),
        nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/drift/findings/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      query(req, []);
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new NotFound();
      await fresh(tenantId);
      const access = await requestEventAccess(service.pool, req, service.ctx);
      const f = await getDriftFinding(service.pool, tenantId, id, access);
      if (!f) throw new NotFound();
      const ids = [
        ...new Set([
          ...f.evidence.map((e) => e.eventId),
          f.openingEventId,
          f.latestEventId,
          ...(f.resolvedByEventId ? [f.resolvedByEventId] : []),
        ]),
      ];
      const present = await existingEventIds(service.pool, tenantId, ids);
      const settings = await service.settings(tenantId);
      return {
        finding: {
          ...summaryView(f),
          latestEventId: f.latestEventId,
          evidence: f.evidence.map((e) => ({
            ...e,
            available: present.has(e.eventId),
            url: present.has(e.eventId) ? `/api/events/${e.eventId}` : null,
          })),
          evidenceOmitted: f.evidenceOmitted,
          eventsPurged: ids.filter((x) => !present.has(x)).length,
          details: f.details,
          journeys: commitsOf(f.details).map((c) => ({
            ...c,
            url: `/api/journeys?${new URLSearchParams({ repository: c.repository, commit: c.commitSha })}`,
          })),
          alert: {
            enabled: f.alert,
            typeAlertsNow: settings.alertTypes.includes(f.type),
            openedNotifiedAt: f.openedNotifiedAt?.toISOString() ?? null,
            resolvedNotifiedAt: f.resolvedNotifiedAt?.toISOString() ?? null,
          },
          detectedAt: f.detectedAt.toISOString(),
          updatedAt: f.updatedAt.toISOString(),
        },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Open findings per matrix cell and per target (for an environment matrix badge).
  app.get("/api/drift/summary", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      query(req, []);
      const evaluation = await fresh(tenantId);
      const access = await requestEventAccess(service.pool, req, service.ctx);
      const counts = await countDriftFindings(service.pool, tenantId, { status: "open", access });
      type Agg = { open: number; maxSeverity: string | null; byType: Record<string, number> };
      const cells = new Map<string, Agg & { service: string; environment: string }>();
      const targets = new Map<string, Agg & { targetKey: string }>();
      const bump = (a: Agg, c: (typeof counts)[number]) => {
        a.open += c.count;
        a.maxSeverity = maxSeverity(a.maxSeverity, c.severity);
        a.byType[c.type] = (a.byType[c.type] ?? 0) + c.count;
      };
      for (const c of counts) {
        const s = c.serviceId ?? UNMAPPED;
        const e = c.environmentId ?? UNMAPPED;
        const k = `${s}\u0000${e}`;
        const cell = cells.get(k) ?? {
          service: s,
          environment: e,
          open: 0,
          maxSeverity: null,
          byType: {},
        };
        bump(cell, c);
        cells.set(k, cell);
        const t = targets.get(c.targetKey) ?? {
          targetKey: c.targetKey,
          open: 0,
          maxSeverity: null,
          byType: {},
        };
        bump(t, c);
        targets.set(c.targetKey, t);
      }
      return {
        evaluatedAt: evaluation?.evaluatedAt ?? null,
        open: counts.reduce((n, c) => n + c.count, 0),
        cells: [...cells.values()],
        targets: [...targets.values()],
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/drift/settings", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      query(req, []);
      const s = await service.settings(tenantId);
      return {
        types: [...DRIFT_FINDING_TYPES],
        severityLevels: [...DRIFT_SEVERITIES],
        defaults: DEFAULT_DRIFT_SEVERITY,
        ...s,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/api/drift/settings", { config: { access: "admin" } }, async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      query(req, []);
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new BadRequest("expected a JSON object");
      for (const k of Object.keys(body))
        if (k !== "alertTypes" && k !== "severities")
          throw new BadRequest(`unknown field ${JSON.stringify(k.slice(0, 64))}`);
      const current = await service.settings(tenantId);
      let alertTypes: string[] | null =
        current.alertTypesSource === "settings" ? current.alertTypes : null;
      if ("alertTypes" in body) {
        const v = body.alertTypes;
        if (v === null) alertTypes = null;
        else if (
          Array.isArray(v) &&
          v.length <= DRIFT_FINDING_TYPES.length &&
          v.every(
            (x) => typeof x === "string" && (DRIFT_FINDING_TYPES as readonly string[]).includes(x),
          )
        )
          alertTypes = [...new Set(v as string[])].sort();
        else
          throw new BadRequest(
            `alertTypes must be null or a list of: ${DRIFT_FINDING_TYPES.join(", ")}`,
          );
      }
      let severities: Record<string, string> = { ...current.severityOverrides } as Record<
        string,
        string
      >;
      if ("severities" in body) {
        const v = body.severities;
        if (!v || typeof v !== "object" || Array.isArray(v))
          throw new BadRequest("severities must be an object of type → severity");
        severities = {};
        for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
          if (!(DRIFT_FINDING_TYPES as readonly string[]).includes(k))
            throw new BadRequest(`unknown finding type ${JSON.stringify(k.slice(0, 64))}`);
          if (!isDriftSeverity(s))
            throw new BadRequest(`severity must be one of: ${DRIFT_SEVERITIES.join(", ")}`);
          severities[k] = s;
        }
      }
      await putDriftSettings(service.pool, tenantId, { alertTypes, severities });
      service.settingsChanged(tenantId);
      const s = await service.settings(tenantId);
      return {
        types: [...DRIFT_FINDING_TYPES],
        severityLevels: [...DRIFT_SEVERITIES],
        defaults: DEFAULT_DRIFT_SEVERITY,
        ...s,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
