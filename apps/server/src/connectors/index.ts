import type { ConnectorModule } from "../context.ts";
import { argocdModule } from "./argocd.ts";
import { vercelModule } from "./vercel.ts";

/**
 * Server modules enabled by default. Each connector or shared feature
 * (connection health, query API) adds its module here.
 */
export const defaultModules: ConnectorModule[] = [argocdModule, vercelModule];
