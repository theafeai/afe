import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Only plain file names become routes (no Fastify path syntax such as ":" or "*").
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Top-level client-side routes of the web UI (apps/web/src/routes.ts). Deep
 * links below these get `index.html` with status 200. Other page paths get it
 * with status 404 for a browser navigation only (`isUnknownPageNavigation`).
 */
export const CLIENT_ROUTE_ROOTS = [
  "github",
  "vercel",
  "argocd",
  "terraform",
  "events",
  "deployments",
  "connections",
  "login",
  "account",
  "users",
  "profile",
  "settings",
  "journeys",
  "drift",
] as const;

/**
 * True for a GET/HEAD of a client-side route (e.g. `/events/<id>`,
 * `/connections/vercel/<id>/projects`) that should get `index.html`.
 */
export function isClientRoute(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = url.split("?")[0] ?? "/";
  if (pathname.includes("..") || pathname.includes("%") || pathname.includes(".")) return false;
  const root = pathname.split("/")[1] ?? "";
  return (CLIENT_ROUTE_ROOTS as readonly string[]).includes(root);
}

/** Server-owned path roots that never get the app shell, even for a browser. */
const SERVER_ROOTS = new Set(["api", "webhooks", "assets", "healthz"]);

/**
 * True for a browser navigation (AFE-121) to a path that is not a client route,
 * such as a mistyped `/nonsense`. It gets `index.html` with status 404, so the
 * app's own "Page not found" shows instead of raw JSON. `/api/*`, `/webhooks/*`,
 * assets and anything that looks like a file keep the JSON 404, as do API clients
 * (no `text/html` in `Accept` and no `Sec-Fetch-Mode: navigate`).
 */
export function isUnknownPageNavigation(
  method: string,
  url: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = url.split("?")[0] ?? "/";
  if (pathname.includes("..") || pathname.includes("%") || pathname.includes(".")) return false;
  if (SERVER_ROOTS.has(pathname.split("/")[1] ?? "")) return false;
  const accept = String(headers.accept ?? "");
  return headers["sec-fetch-mode"] === "navigate" || /\btext\/html\b/.test(accept);
}

/**
 * Serves the built web UI (`apps/web/dist`) from `dir` (`AFE_WEB_DIR`).
 *
 * The file set is read once at startup and one GET route is registered per
 * file, so only files that existed at startup can be served (no path
 * traversal surface) and the root filesystem can stay read-only.
 * `index.html` is also served at `/` and, as an SPA fallback, for any other
 * GET of a client-side route (deep links and OAuth/install redirects such as
 * `/connections/vercel/<id>/projects`). A browser navigation to any other page
 * path also gets `index.html`, with status 404, so the client shows "Page not
 * found" (AFE-121). Unknown `/api/*`, `/webhooks/*` and asset paths, and API
 * clients, keep their JSON 404. Returns the number of files served.
 */
export async function registerWebUi(app: FastifyInstance, dir: string): Promise<number> {
  const files = (await listFiles(dir)).filter((f) => SAFE_PATH.test(f));
  for (const rel of files) {
    const body = await readFile(path.join(dir, rel));
    const type = CONTENT_TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
    // Vite puts content-hashed files under assets/; everything else may change.
    const cache = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    const send = (_req: unknown, reply: FastifyReply) =>
      reply
        .header("content-type", type)
        .header("cache-control", cache)
        .header("x-content-type-options", "nosniff")
        .send(body);
    app.get(`/${rel}`, send);
    if (rel === "index.html") {
      app.get("/", send);
      app.setNotFoundHandler((req, reply) => {
        if (isClientRoute(req.method, req.url)) return send(req, reply);
        if (isUnknownPageNavigation(req.method, req.url, req.headers))
          return send(req, reply.code(404));
        return reply.code(404).send({
          message: `Route ${req.method}:${req.url.split("?")[0]} not found`,
          error: "Not Found",
          statusCode: 404,
        });
      });
    }
  }
  return files.length;
}
