/**
 * /api/v2 router
 *
 * v2 currently re-exports all v1 handlers unchanged — no breaking changes yet.
 * This module exists to provide the versioning infrastructure so that genuine
 * v2-only routes can be added alongside v1 without disrupting existing clients.
 *
 * Routing:
 *   GET /api/v2/players  → same handler as /api/v1/players
 *   GET /api/v2/scouts/… → same handlers as /api/v1/scouts/…
 *   …and so on for all resource routers.
 */

export { default as playerRoutes } from '../player';
export { default as scoutRoutes } from '../scout';
export { default as validatorRoutes } from '../validator';
export { default as adminRoutes } from '../admin';
export { default as eventsRoutes } from '../events';

// v2-only routes can be exported here to be mounted under /api/v2.
export { default as versioningDemoRoutes } from './versioning';
