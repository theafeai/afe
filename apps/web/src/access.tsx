import { createContext, useContext } from "react";
import type { SessionInfo } from "./api/types.ts";
export interface ProfileTool {
  tool: string;
  mode: string;
  linked: boolean;
  accountName: string | null;
  oauthAvailable: boolean;
  sourceEnabled: boolean;
  sourceAvailable?: boolean;
}
export interface ProfileInfo {
  managedUser: boolean;
  tools: ProfileTool[];
}
export const AccessContext = createContext<{
  session: SessionInfo | null;
  profile: ProfileInfo | null;
}>({ session: null, profile: null });
export function useAccess() {
  const { session, profile } = useContext(AccessContext);
  const managed = Boolean(session?.principal.managedUser);
  return {
    managed,
    admin: session ? session.principal.roles.includes("admin") : true,
    visibleTool: (tool: string) => !managed || Boolean(profile?.tools.some((t) => t.tool === tool)),
    profile,
  };
}
