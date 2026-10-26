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
 * Serves the built web UI (`apps/web/dist`) from `dir` (`AFE_WEB_DIR`).
 *
 * The file set is read once at startup and one GET route is registered per
 * file, so only files that existed at startup can be served (no path
 * traversal surface) and the root filesystem can stay read-only.
 * `index.html` is also served at `/`. Returns the number of files served.
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
    if (rel === "index.html") app.get("/", send);
  }
  return files.length;
}
