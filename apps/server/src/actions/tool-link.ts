import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Tools whose actions run with each person's own linked account (D-0022). */
export type LinkedTool = "github" | "vercel" | "terraform" | "argocd";

/**
 * Why a person cannot act on a tool yet, when that is an expected state rather than
 * a denial (AFE-118):
 * - `tool_not_linked`: they can link their own account for the tool in Profile.
 * - `named_user_required`: the session is a shared credential (the administrator
 *   password or viewer token), which cannot hold a personal tool account.
 */
export type ToolLinkReason = "tool_not_linked" | "named_user_required";

/**
 * A 403 that the UI shows as a calm "link your account" state. Authorization is
 * unchanged: it is still a 403 and nothing is served; only the body says why.
 * Real permission errors (Source access disabled, source RBAC, token scopes) keep
 * using plain 403 errors.
 */
export class ToolLinkRequiredError extends Error {
  readonly statusCode = 403;
  constructor(
    readonly tool: LinkedTool,
    readonly reason: ToolLinkReason,
    message: string,
  ) {
    super(message);
    this.name = "ToolLinkRequiredError";
  }
}

export const toolNotLinked = (tool: LinkedTool, message: string) =>
  new ToolLinkRequiredError(tool, "tool_not_linked", message);

export const namedUserRequired = (tool: LinkedTool, message: string) =>
  new ToolLinkRequiredError(tool, "named_user_required", message);

/** `{"error":"forbidden","reason":"tool_not_linked","tool":"vercel","message":…}` */
export function toolLinkBody(error: ToolLinkRequiredError) {
  return {
    statusCode: 403,
    error: "forbidden",
    reason: error.reason,
    tool: error.tool,
    message: error.message,
  };
}

function handler(error: FastifyError, _req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ToolLinkRequiredError)
    return reply.code(403).header("cache-control", "no-store").send(toolLinkBody(error));
  // Anything else goes to the parent (default) error handler unchanged.
  throw error;
}

/**
 * Fastify's default error handler only serializes `statusCode`, `code`, `error` and
 * `message`. Routes registered after this call whose URL starts with `prefix` get an
 * error handler that adds `reason` and `tool` for `ToolLinkRequiredError`.
 */
export function serveToolLinkErrors(app: FastifyInstance, prefix: string) {
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith(prefix) && !route.errorHandler) route.errorHandler = handler;
  });
}
