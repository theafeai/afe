import type { ConnectorModule } from "../context.ts";
import { eventsApiModule } from "../api/events.ts";

/**
 * Server modules enabled by default. Each connector or shared feature
 * (connection health, query API) adds its module here.
 */
export const defaultModules: ConnectorModule[] = [eventsApiModule];
