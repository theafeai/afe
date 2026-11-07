import {
  getConnection,
  getCredential,
  getLocalUser,
  getUserToolPolicy,
  listConnections,
} from "@afe/db";
import type { EventAccessRule } from "@afe/core";
import { TerraformClient, remoteConnectionInput, relatedId } from "@afe/connector-terraform";
import type { ServerContext } from "../context.ts";

export interface TerraformAccount {
  credential_id: string;
  context: { serverUrl?: string; accountId?: string; actionsEnabled?: boolean };
}
export const terraformFail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
export function terraformPolicy(ctx: ServerContext) {
  return {
    allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
    allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
  };
}
export async function terraformAccount(ctx: ServerContext, tid: string, uid: string) {
  const user = await getLocalUser(ctx.pool, tid, uid);
  if (
    !user ||
    user.disabled ||
    (await getUserToolPolicy(ctx.pool, tid, uid, "terraform")).mode !== "source"
  )
    throw terraformFail(403, "Terraform access is disabled for this user.");
  const account = (
    await ctx.pool.query<TerraformAccount>(
      "SELECT credential_id,context FROM user_tool_accounts WHERE tenant_id=$1 AND user_id=$2 AND tool='terraform'",
      [tid, uid],
    )
  ).rows[0];
  if (!account?.context.serverUrl || !account.context.accountId)
    throw terraformFail(403, "Link a personal Terraform user token in Profile.");
  const credential = await getCredential(ctx.pool, ctx.keys, tid, account.credential_id);
  if (!credential) throw terraformFail(403, "Relink your Terraform account in Profile.");
  const api = new TerraformClient(
    account.context.serverUrl,
    credential.secret,
    terraformPolicy(ctx),
  );
  const userInfo = await api.identity();
  if (userInfo.id !== account.context.accountId)
    throw terraformFail(403, "Terraform identity changed. Relink your account.");
  return { account, api };
}
export async function terraformScope(
  ctx: ServerContext,
  tid: string,
  uid: string,
  connectionId: string,
) {
  const connection = await getConnection(ctx.pool, tid, connectionId);
  const config = remoteConnectionInput.safeParse(connection?.config);
  if (!connection || connection.source !== "terraform" || !config.success)
    throw terraformFail(
      404,
      "Remote Terraform workspace not found. CLI reporters cannot operate infrastructure.",
    );
  if (connection.status !== "active")
    throw terraformFail(409, "The Terraform connection is inactive.");
  const { account, api } = await terraformAccount(ctx, tid, uid);
  if (config.data.serverUrl !== account.context.serverUrl)
    throw terraformFail(403, "Link your personal account for this Terraform server.");
  const workspace = await api.resource(
    `/api/v2/workspaces/${config.data.workspaceId}`,
    config.data.workspaceId,
    "workspaces",
  );
  if (relatedId(workspace, "organization") !== config.data.organization)
    throw terraformFail(404, "Workspace is outside the connection's organization.");
  return { connection, config: config.data, account, api, workspace };
}
/** Only remote, tenant-selected workspace connections. CLI reports never inherit remote authority. */
export async function terraformSourceAccess(
  ctx: ServerContext,
  tid: string,
  uid: string,
): Promise<EventAccessRule[]> {
  const rules: EventAccessRule[] = [];
  for (const c of await listConnections(ctx.pool, tid)) {
    if (
      c.source !== "terraform" ||
      !remoteConnectionInput.safeParse(c.config).success ||
      c.status !== "active"
    )
      continue;
    try {
      await terraformScope(ctx, tid, uid, c.id);
      rules.push({ source: "terraform", resource: `connection:${c.id}`, connectionId: c.id });
    } catch {
      /* A remote denial cannot grant access to a CLI reporter. */
    }
  }
  return rules;
}
