import type { ConnectorModule } from "../context.ts";
import { healthModule } from "../health/index.ts";

/**
 * Server modules enabled by default. Each connector or shared feature
 * (connection health, query API) adds its module here.
 */
export const defaultModules: ConnectorModule[] = [
  // Connection health (AFE-13): collects every module's `health` hooks.
  healthModule,
];
