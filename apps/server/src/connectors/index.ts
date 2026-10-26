import type { ConnectorModule } from "../context.ts";
import { eventsApiModule } from "../api/events.ts";
import { healthModule } from "../health/index.ts";
import { argocdModule } from "./argocd.ts";
import { githubModule } from "./github.ts";
import { vercelModule } from "./vercel.ts";

/**
 * Server modules enabled by default. Each connector or shared feature
 * (connection health, query API) adds its module here.
 */
export const defaultModules: ConnectorModule[] = [
  githubModule,
  argocdModule,
  vercelModule,
  // Connection health (AFE-13): collects every module's `health` hooks.
  healthModule,
  // Audit query API and verifiable export (AFE-14).
  eventsApiModule,
];
