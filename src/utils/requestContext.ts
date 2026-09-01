import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  correlationId: string;
}

/**
 * AsyncLocalStorage that carries per-request context (correlationId) implicitly
 * through the entire async call chain — no manual parameter threading required.
 *
 * Usage:
 *   - Set by correlationId middleware via requestContext.run(...)
 *   - Read anywhere via getCorrelationId()
 *   - Background jobs have no active store, so getCorrelationId() returns undefined
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the correlationId for the current async context, or undefined outside a request. */
export function getCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlationId;
}
