// Client_IP for the rate limiter (Requirements 15.3-15.6).
// Only CloudFront-Viewer-Address and the socket address are read. X-Forwarded-For
// is never read, and Express `trust proxy` stays disabled.
//
// Rules, in order:
// - A header given as an array uses its first element. An empty array counts as absent.
// - A missing or empty header, a header without ':', or a header whose part before
//   the last ':' is empty, falls back to the socket address.
// - Otherwise the Client_IP is everything before the last ':'. IPv6 values keep
//   their brackets when present, for example '[2001:db8::1]:443' gives '[2001:db8::1]'.
// - A missing socket address gives the fixed value 'unknown'.
const UNKNOWN_CLIENT_IP = 'unknown';
const VIEWER_ADDRESS_HEADER = 'cloudfront-viewer-address';

type HeaderValue = string | string[] | undefined;

function firstHeaderValue(headerValue: HeaderValue): string | undefined {
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

export function deriveClientIp(
  headerValue: HeaderValue,
  socketAddress: string | undefined,
): string {
  const socket = socketAddress || UNKNOWN_CLIENT_IP;
  const value = firstHeaderValue(headerValue);
  if (!value) return socket;
  const lastColon = value.lastIndexOf(':');
  if (lastColon <= 0) return socket;
  return value.slice(0, lastColon);
}

export interface TrackerRequest {
  headers?: Record<string, HeaderValue>;
  socket?: { remoteAddress?: string };
}

export async function clientIpTracker(req: TrackerRequest): Promise<string> {
  return deriveClientIp(req.headers?.[VIEWER_ADDRESS_HEADER], req.socket?.remoteAddress);
}
