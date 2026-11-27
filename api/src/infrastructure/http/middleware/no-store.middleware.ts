import type { ServerResponse } from 'node:http';
export const CACHE_CONTROL_HEADER = 'cache-control';
export const NO_STORE_VALUE = 'no-store';
// Mounted first so every response, including 403 from the origin guard and error envelopes, is uncacheable.
export function noStoreMiddleware(_req: unknown, res: ServerResponse, next: () => void): void {
  res.setHeader(CACHE_CONTROL_HEADER, NO_STORE_VALUE);
  next();
}
