import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { TOOL_PERMISSION_MODES, type ToolPolicy } from "@afe/core";
import {
  createLocalUser,
  getLocalUser,
  getUserToolPolicy,
  listLocalUsers,
  resetLocalCredential,
  setLocalUserDisabled,
  setUserToolPolicy,
} from "@afe/db";
import { requestTenant } from "./index.ts";

export const USER_TOOLS = ["github", "vercel", "argocd", "terraform"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerUserRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/admin/users") || req.url.startsWith("/api/profile"))
      reply.header("cache-control", "no-store");
    return payload;
  });
  app.get("/api/admin/users", { config: { access: "admin" } }, async (req) => ({
    users: await listLocalUsers(pool, requestTenant(req)),
  }));
  app.post<{ Body: { username?: unknown } }>(
    "/api/admin/users",
    { config: { access: "admin" }, bodyLimit: 4096 },
    async (req, reply) => {
      if (
        typeof req.body?.username !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(req.body.username.trim())
      )
        return reply.code(400).send({ error: "invalid_username" });
      try {
        return reply
          .code(201)
          .send(await createLocalUser(pool, requestTenant(req), req.body.username));
      } catch (err) {
        if ((err as { code?: string }).code === "23505")
          return reply.code(409).send({ error: "username_exists" });
        throw err;
      }
    },
  );
  app.patch<{ Params: { id: string }; Body: { disabled?: unknown } }>(
    "/api/admin/users/:id",
    { config: { access: "admin" } },
    async (req, reply) => {
      if (
        !uuid.test(req.params.id) ||
        !(await getLocalUser(pool, requestTenant(req), req.params.id))
      )
        return reply.code(404).send({ error: "not_found" });
      if (typeof req.body?.disabled !== "boolean")
        return reply.code(400).send({ error: "bad_request" });
      if (!(await setLocalUserDisabled(pool, requestTenant(req), req.params.id, req.body.disabled)))
        return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/credentials",
    { config: { access: "admin" } },
    async (req, reply) => {
      if (!uuid.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
      const token = await resetLocalCredential(pool, requestTenant(req), req.params.id);
      return token ? { token } : reply.code(404).send({ error: "not_found" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/admin/users/:id/permissions",
    { config: { access: "admin" } },
    async (req, reply) => {
      const tid = requestTenant(req);
      if (!uuid.test(req.params.id) || !(await getLocalUser(pool, tid, req.params.id)))
        return reply.code(404).send({ error: "not_found" });
      return {
        tools: Object.fromEntries(
          await Promise.all(
            USER_TOOLS.map(async (tool) => [
              tool,
              await getUserToolPolicy(pool, tid, req.params.id, tool),
            ]),
          ),
        ),
      };
    },
  );
  app.put<{ Params: { id: string; tool: string }; Body: ToolPolicy }>(
    "/api/admin/users/:id/permissions/:tool",
    { config: { access: "admin" }, bodyLimit: 65536 },
    async (req, reply) => {
      const tid = requestTenant(req),
        p = req.body;
      if (!uuid.test(req.params.id) || !(await getLocalUser(pool, tid, req.params.id)))
        return reply.code(404).send({ error: "not_found" });
      if (
        !(USER_TOOLS as readonly string[]).includes(req.params.tool) ||
        !p ||
        !TOOL_PERMISSION_MODES.includes(p.mode) ||
        !Array.isArray(p.custom) ||
        p.custom.length > 200 ||
        p.custom.some(
          (g) =>
            !g ||
            typeof g.resource !== "string" ||
            g.resource.length > 512 ||
            !/^(connection|repository|project|application):.+$/.test(g.resource) ||
            g.action !== "read",
        )
      )
        return reply.code(400).send({
          error: "invalid_policy",
          message:
            "Use read grants with connection:, repository:, project: or application: resource identifiers.",
        });
      await setUserToolPolicy(pool, tid, req.params.id, req.params.tool, p);
      return { ok: true };
    },
  );
}
