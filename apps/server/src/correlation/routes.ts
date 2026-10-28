/**
 * Correlation API (AFE-20): environment matrix, per-target placement
 * history, per-commit journeys and an event's links. Read-only, viewer
 * access (ADR 0006); the tenant is always `requestTenant(req)`.
 * Reference: docs/api.md "Environments and journeys".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eventAllowed, filterFingerprint, repositoryKey } from "@afe/core";
import type { MappingConfig } from "@afe/core/mapping";
import {
  applyContainment,
  buildJourney,
  confidenceRank,
  containmentCandidates,
  sameContent,
  STAGES,
  type ContainmentEvidence,
  type EnvironmentState,
} from "@afe/core/correlation";
import { getEvent, type CorrelationEventRecord } from "@afe/db";
import { requestEventAccess } from "../auth/permissions.ts";
import { requestTenant } from "../auth/index.ts";
import type { ServerContext } from "../context.ts";
import type { MappingService, PlacementView } from "../mapping/service.ts";
import type { CorrelationService, Snapshot } from "./service.ts";
import {
  asMappable,
  causesOf,
  decodeCursor,
  encodeCursor,
  eventSummary,
  placementSummary,
  targetView,
  UNMAPPED,
} from "./views.ts";

/** Optional hook: is `commit` included in `liveCommit` (AFE-22 commit containment)? */
export interface JourneyContainmentHook {
  isContained(
    tenantId: string,
    repository: string,
    commit: string,
    liveCommit: string,
    options?: { timeoutMs?: number },
  ): Promise<{ contained: boolean | "unknown"; reason: string }>;
}

export interface CorrelationRouteOptions {
  /** Containment checks per journey (`include=containment`). Default 5. */
  maxContainmentChecks?: number;
  /** Time budget per containment check. Default 5 s. */
  containmentTimeoutMs?: number;
  containment?: (ctx: ServerContext) => JourneyContainmentHook | undefined;
}

class BadRequest extends Error {}
class NotFound extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function single(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) throw new BadRequest(`${key} may only be given once`);
  return String(v);
}

function intParam(q: Record<string, unknown>, key: string, def: number, max: number): number {
  const raw = single(q, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new BadRequest(`${key} must be an integer from 1 to ${max}`);
  return n;
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof BadRequest)
    return reply.code(400).send({ error: "bad_request", message: err.message });
  if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
  throw err;
}

interface Dims {
  services: { id: string; name: string }[];
  environments: { id: string; name: string; kind: string; order: number }[];
}

async function dimensions(
  ctx: ServerContext,
  tenantId: string,
  snapshot?: Snapshot,
): Promise<Dims> {
  const m = ctx.mapping as Partial<MappingService> | undefined;
  if (!m?.load) return { services: [], environments: [] };
  const { config } = await m.load(tenantId);
  const dims = dimsOf(config);
  if (!snapshot) return dims;
  const placements = await resolveTargets(ctx, tenantId, snapshot, snapshot.graph.environments);
  const services = new Set([...placements.values()].map((p) => p?.service?.id));
  const environments = new Set([...placements.values()].map((p) => p?.environment?.id));
  return {
    services: dims.services.filter((s) => services.has(s.id)),
    environments: dims.environments.filter((e) => environments.has(e.id)),
  };
}

function dimsOf(config: MappingConfig): Dims {
  return {
    services: config.services.map((s) => ({ id: s.id, name: s.name })),
    environments: [...config.environments]
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind, order: e.order })),
  };
}

/** Service/environment of each target, from its current placement (AFE-19 mapping). */
async function resolveTargets(
  ctx: ServerContext,
  tenantId: string,
  snap: Snapshot,
  states: EnvironmentState[],
): Promise<Map<string, PlacementView | null>> {
  const out = new Map<string, PlacementView | null>();
  const records = states.map((s) => snap.events.get(s.current.eventId)!);
  const placements = ctx.mapping
    ? await ctx.mapping.placements(tenantId, records.map(asMappable))
    : new Map<string, PlacementView>();
  for (const s of states) out.set(s.key, placements.get(s.current.eventId) ?? null);
  return out;
}

const cellKey = (service: string | null, environment: string | null) =>
  `${service ?? UNMAPPED}\u0000${environment ?? UNMAPPED}`;

export function registerCorrelationRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  service: CorrelationService,
  options: CorrelationRouteOptions = {},
) {
  /** Query parameters; unknown ones are rejected (a typo never silently changes a query). */
  const query = (req: FastifyRequest, allowed: readonly string[]) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(q))
      if (!allowed.includes(k))
        throw new BadRequest(`unknown parameter ${JSON.stringify(k.slice(0, 64))}`);
    return q;
  };

  // --- Environment matrix -------------------------------------------------
  app.get("/api/environments/state", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const q = query(req, ["service", "environment", "source", "targets"]);
      const serviceFilter = single(q, "service");
      const envFilter = single(q, "environment");
      const sourceFilter = single(q, "source");
      const maxTargets = intParam(q, "targets", 20, 100);
      const access = await requestEventAccess(ctx.pool, req, ctx);
      const snap = await service.snapshot(tenantId, access);
      const dims = await dimensions(ctx, tenantId, access === undefined ? undefined : snap);
      for (const [name, v, list] of [
        ["service", serviceFilter, dims.services],
        ["environment", envFilter, dims.environments],
      ] as const) {
        if (v !== undefined && v !== UNMAPPED && !list.some((x) => x.id === v))
          throw new BadRequest(`unknown ${name} ${JSON.stringify(v.slice(0, 64))}`);
      }
      const states = snap.graph.environments.filter(
        (s) => !sourceFilter || s.source === sourceFilter,
      );
      const resolved = await resolveTargets(ctx, tenantId, snap, states);

      const cells = new Map<
        string,
        { service: string | null; env: string | null; states: EnvironmentState[] }
      >();
      for (const s of states) {
        const r = resolved.get(s.key);
        const sid = r?.service?.id ?? null;
        const eid = r?.environment?.id ?? null;
        if (serviceFilter && (sid ?? UNMAPPED) !== serviceFilter) continue;
        if (envFilter && (eid ?? UNMAPPED) !== envFilter) continue;
        const k = cellKey(sid, eid);
        const cell = cells.get(k) ?? { service: sid, env: eid, states: [] };
        cell.states.push(s);
        cells.set(k, cell);
      }
      const svcOrder = new Map(dims.services.map((s, i) => [s.id, i]));
      const envOrder = new Map(dims.environments.map((e, i) => [e.id, i]));
      const ord = (m: Map<string, number>, id: string | null) =>
        id === null ? Number.MAX_SAFE_INTEGER : (m.get(id) ?? Number.MAX_SAFE_INTEGER - 1);
      const sortedCells = [...cells.values()].sort(
        (a, b) =>
          ord(svcOrder, a.service) - ord(svcOrder, b.service) ||
          ord(envOrder, a.env) - ord(envOrder, b.env),
      );
      const usesUnmapped = (dim: "service" | "env") =>
        sortedCells.some((c) => (dim === "service" ? c.service : c.env) === null);

      return {
        asOf: snap.window.to,
        window: snap.window,
        services: [
          ...dims.services.map((s) => ({ ...s, unmapped: false })),
          ...(usesUnmapped("service") ? [{ id: UNMAPPED, name: "Unmapped", unmapped: true }] : []),
        ],
        environments: [
          ...dims.environments.map((e) => ({ ...e, unmapped: false })),
          ...(usesUnmapped("env")
            ? [{ id: UNMAPPED, name: "Unmapped", kind: "other", order: null, unmapped: true }]
            : []),
        ],
        cells: sortedCells.map((c) => {
          const byRecency = [...c.states].sort((a, b) =>
            a.current.at < b.current.at ? 1 : a.current.at > b.current.at ? -1 : 0,
          );
          const targets = byRecency
            .slice(0, maxTargets)
            .map((s) => targetView(snap, s, resolved.get(s.key) ?? null));
          const live = targets[0]!;
          const allGaps = targets.flatMap((t) => t.current.gaps);
          const first = byRecency[0]!.current;
          return {
            service: c.service ?? UNMAPPED,
            environment: c.env ?? UNMAPPED,
            unmapped: c.service === null || c.env === null,
            live: { targetKey: live.key, label: live.label, ...live.current },
            since: live.since,
            contentSince: live.contentSince,
            confidence: live.current.attribution.confidence,
            status: live.current.attribution.status,
            /** Every target of the cell runs the same content. */
            consistent: byRecency.every((s) => s === byRecency[0] || sameContent(s.current, first)),
            gap: {
              flagged: allGaps.length > 0,
              evidenceInGap: allGaps.some((g) => g.relation === "evidence_in_gap"),
              possiblyStale: allGaps.some((g) => g.relation === "after_placement"),
            },
            targets,
            targetsOmitted: Math.max(0, byRecency.length - targets.length),
            historyUrl: `/api/environments/${c.service ?? UNMAPPED}/${c.env ?? UNMAPPED}/history`,
          };
        }),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- Placement history of one cell --------------------------------------
  app.get<{ Params: { service: string; environment: string } }>(
    "/api/environments/:service/:environment/history",
    async (req, reply) => {
      try {
        const tenantId = requestTenant(req);
        const { service: sid, environment: eid } = req.params;
        const q = query(req, ["limit", "cursor", "target"]);
        const limit = intParam(q, "limit", 50, 200);
        const targetFilter = single(q, "target");
        const cursorRaw = single(q, "cursor");
        const access = await requestEventAccess(ctx.pool, req, ctx);
        const snap = await service.snapshot(tenantId, access);
        const dims = await dimensions(ctx, tenantId, access === undefined ? undefined : snap);
        const svc = sid === UNMAPPED ? null : dims.services.find((s) => s.id === sid);
        const env = eid === UNMAPPED ? null : dims.environments.find((e) => e.id === eid);
        if (
          (sid !== UNMAPPED && (!SLUG.test(sid) || !svc)) ||
          (eid !== UNMAPPED && (!SLUG.test(eid) || !env))
        )
          throw new NotFound();
        const scope = `${sid}/${eid}/${targetFilter ?? ""}${access === undefined ? "" : "/" + filterFingerprint({}, { tenantId, access: JSON.stringify(access) })}`;
        const cursor = cursorRaw ? decodeCursor(cursorRaw, scope) : null;
        if (cursorRaw && !cursor) throw new BadRequest("invalid or mismatched cursor");

        const resolved = await resolveTargets(ctx, tenantId, snap, snap.graph.environments);
        const states = snap.graph.environments.filter((s) => {
          const r = resolved.get(s.key);
          return (
            (r?.service?.id ?? UNMAPPED) === sid &&
            (r?.environment?.id ?? UNMAPPED) === eid &&
            (!targetFilter || s.key === targetFilter)
          );
        });
        const items = states.flatMap((s) =>
          s.history.map((p, i) => ({ state: s, p, prev: i > 0 ? s.history[i - 1]! : null })),
        );
        items.sort((a, b) =>
          a.p.at < b.p.at ? 1 : a.p.at > b.p.at ? -1 : a.p.eventId < b.p.eventId ? 1 : -1,
        );
        const start = cursor
          ? items.findIndex(
              (x) => x.p.at < cursor.at || (x.p.at === cursor.at && x.p.eventId < cursor.id),
            )
          : 0;
        const page = start < 0 ? [] : items.slice(start, start + limit);
        const last = page.at(-1);
        const hasMore = start >= 0 && start + limit < items.length;
        return {
          service: svc
            ? { ...svc, unmapped: false }
            : { id: UNMAPPED, name: "Unmapped", unmapped: true },
          environment: env
            ? { ...env, unmapped: false }
            : { id: UNMAPPED, name: "Unmapped", unmapped: true },
          window: snap.window,
          targets: states.map((s) => ({
            key: s.key,
            source: s.source,
            label: s.label,
            toolEnvironment: s.environment,
            currentEventId: s.current.eventId,
            placements: s.history.length,
          })),
          total: items.length,
          items: page.map(({ state, p, prev }) => ({
            target: { key: state.key, source: state.source, label: state.label },
            current: state.current.eventId === p.eventId,
            change: !prev ? "first" : sameContent(prev, p) ? "same_content" : "new_content",
            previousEventId: prev?.eventId ?? null,
            placement: placementSummary(snap, p, state.current.eventId === p.eventId),
            event: eventSummary(snap.graph.events.get(p.eventId)!),
            causes: causesOf(snap, p.eventId),
          })),
          nextCursor: hasMore && last ? encodeCursor(last.p.at, last.p.eventId, scope) : null,
        };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // --- Per-commit journey -------------------------------------------------
  app.get("/api/journeys", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const q = query(req, ["repository", "commit", "include", "maxSteps"]);
      const repoRaw = single(q, "repository");
      const commitRaw = single(q, "commit")?.toLowerCase();
      if (!repoRaw || repoRaw.length > 300) throw new BadRequest("repository is required");
      if (!commitRaw || !COMMIT.test(commitRaw))
        throw new BadRequest("commit must be 7 to 64 hex characters");
      const include = new Set((single(q, "include") ?? "").split(",").filter(Boolean));
      for (const i of include)
        if (i !== "containment") throw new BadRequest(`unknown include ${JSON.stringify(i)}`);
      const maxSteps = intParam(q, "maxSteps", 300, 2000);
      let repository: string;
      try {
        repository = repositoryKey(repoRaw);
      } catch {
        throw new BadRequest("invalid repository");
      }
      const access = await requestEventAccess(ctx.pool, req, ctx);
      const snap = await service.snapshot(tenantId, access);
      let sha = commitRaw;
      if (sha.length !== 40 && sha.length !== 64) {
        const matches = [...snap.graph.commitIndex.keys()].filter((s) => s.startsWith(sha));
        const inRepo = matches.filter((s) =>
          snap.graph.commitIndex
            .get(s)!
            .some((id) =>
              snap.graph.events.get(id)!.correlation.repositories?.includes(repository),
            ),
        );
        if (inRepo.length > 1)
          return reply.code(400).send({
            error: "bad_request",
            message: "ambiguous commit prefix",
            candidates: inRepo.slice(0, 10),
          });
        if (inRepo.length === 0) throw new NotFound();
        sha = inRepo[0]!;
      }
      let journey = buildJourney(snap.graph, repository, sha, { maxSteps });
      if (!journey) throw new NotFound();

      let containment: (ContainmentEvidence & { environmentKey: string })[] | null = null;
      if (include.has("containment")) {
        const hook = req.principal?.localUserId ? undefined : options.containment?.(ctx);
        containment = [];
        if (hook) {
          const candidates = containmentCandidates(snap.graph, journey).slice(
            0,
            options.maxContainmentChecks ?? 5,
          );
          const results = await Promise.all(
            candidates.map(async (c) => {
              try {
                const v = await hook.isContained(tenantId, repository, sha, c.liveCommitSha, {
                  timeoutMs: options.containmentTimeoutMs ?? 5000,
                });
                return { ...c, contained: v.contained, reason: v.reason };
              } catch (err) {
                return { ...c, contained: "unknown" as const, reason: (err as Error).message };
              }
            }),
          );
          journey = applyContainment(snap.graph, journey, results);
          containment = results.map((r) => ({
            ...r,
            environmentKey: snap.graph.placements.get(r.placementEventId)!.state.key,
          }));
        }
      }

      const envStates = journey.environments.map(
        (e) => snap.graph.placements.get(e.placementEventId)!.state,
      );
      const resolved = await resolveTargets(ctx, tenantId, snap, [...new Set(envStates)]);
      const stepIds = new Set(journey.steps.map((s) => s.eventId));
      const ev = (id: string) => eventSummary(snap.graph.events.get(id)!);
      const steps = journey.steps.map((s) => ({ ...s, event: ev(s.eventId) }));
      const stepEvents = journey.steps.map((s) => snap.graph.events.get(s.eventId)!);
      const gapIds = new Set<string>();
      const gaps = stepEvents
        .flatMap((e) => snap.gaps.containing(e).map((g) => ({ ...g, eventId: e.id })))
        .filter((g) => !gapIds.has(g.gapId) && gapIds.add(g.gapId));
      return {
        window: snap.window,
        journey: {
          id: journey.id,
          repository: journey.repository,
          commitSha: journey.commitSha,
          ref: journey.ref ?? null,
          startedAt: journey.startedAt,
          root: ev(journey.rootEventId),
          stages: STAGES.map((stage) => ({
            stage,
            steps: steps.filter((s) => s.stage === stage).map((s) => s.eventId),
          })).filter((s) => s.steps.length > 0),
          steps,
          edges: journey.edges,
          environments: journey.environments.map((e) => {
            const state = snap.graph.placements.get(e.placementEventId)!.state;
            const r = resolved.get(state.key) ?? null;
            return {
              ...e,
              target: { key: state.key, source: state.source, label: state.label },
              service: r?.service?.id ?? UNMAPPED,
              environment: r?.environment?.id ?? UNMAPPED,
              event: ev(e.placementEventId),
            };
          }),
          excluded: journey.excluded.map((x) => ({ ...x, event: ev(x.eventId) })),
          continuesAs: journey.continuesAs,
          conflicts: snap.graph.conflicts
            .filter((c) => c.events.some((id) => stepIds.has(id)))
            .slice(0, 20),
          gaps,
          truncated: journey.truncated,
          containment,
        },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- Links of one event -------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/events/:id/links", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!UUID.test(req.params.id)) throw new NotFound();
      const limit = intParam(query(req, ["limit"]), "limit", 50, 200);
      const stored = await getEvent(ctx.pool, tenantId, req.params.id);
      if (!stored) throw new NotFound();
      const access = await requestEventAccess(ctx.pool, req, ctx);
      const snap = await service.snapshot(tenantId, access);
      if (access && !eventAllowed(access, stored)) throw new NotFound();
      const id = stored.id;
      const inWindow = snap.graph.events.has(id);
      const links = (snap.graph.adjacency.get(id) ?? [])
        .map((l) => {
          const otherId = l.from === id ? l.to : l.from;
          return {
            direction: l.from === id ? ("later" as const) : ("earlier" as const),
            confidence: l.confidence,
            evidence: l.evidence,
            event: eventSummary(snap.graph.events.get(otherId)!),
          };
        })
        .sort(
          (a, b) =>
            confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
            (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : 0),
        );
      const placed = snap.graph.placements.get(id);
      return {
        eventId: id,
        inWindow,
        window: snap.window,
        total: links.length,
        links: links.slice(0, limit),
        conflicts: snap.graph.conflicts.filter((c) => c.events.includes(id)),
        placement: placed
          ? {
              target: {
                key: placed.state.key,
                source: placed.state.source,
                label: placed.state.label,
              },
              current: placed.state.current.eventId === id,
              ...placementSummary(snap, placed.placement, placed.state.current.eventId === id),
            }
          : null,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

export type { CorrelationEventRecord };
