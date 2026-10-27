import type { ConnectorModule } from "../context.ts";
import { eventsApiModule } from "../api/events.ts";
import { containmentModule } from "../containment/index.ts";
import { healthModule } from "../health/index.ts";
import { mappingModule } from "../mapping/index.ts";
import { retentionModule } from "../retention.ts";
import { argocdModule } from "./argocd.ts";
import { argocdAgentModule } from "./argocd-agent.ts";
import { githubModule } from "./github.ts";
import { vercelModule } from "./vercel.ts";

/**
 * Server modules enabled by default. Each connector or shared feature
 * (connection health, query API) adds its module here.
 */
export const defaultModules: ConnectorModule[] = [
  githubModule,
  argocdModule,
  // In-cluster ArgoCD agent ingest (AFE-28).
  argocdAgentModule,
  vercelModule,
  // Connection health (AFE-13): collects every module's `health` hooks.
  healthModule,
  // Event query API (AFE-14).
  eventsApiModule,
  // Environment and service mapping (AFE-19).
  mappingModule,
  // Retention purge of expired events (ADR 0008).
  retentionModule,
  // Commit containment: is commit X in what is live (AFE-22).
  containmentModule,
];
