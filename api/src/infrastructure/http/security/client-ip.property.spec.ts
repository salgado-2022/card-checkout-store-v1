import * as fc from 'fast-check';
import { clientIpTracker, deriveClientIp } from './client-ip';

const NUM_RUNS = 100;
const UNKNOWN = 'unknown';

// Addresses from the documentation ranges are not required here: fast-check generates
// every shape, which is what the parser must handle.
const octet = fc.integer({ min: 0, max: 255 });
const ipv4 = fc.tuple(octet, octet, octet, octet).map((parts) => parts.join('.'));

const hextet = fc.integer({ min: 0, max: 0xffff }).map((value) => value.toString(16));
const ipv6 = fc.array(hextet, { minLength: 8, maxLength: 8 }).map((parts) => parts.join(':'));

const ipAddress = fc.oneof(ipv4, ipv6);
const port = fc.integer({ min: 0, max: 65535 }).map(String);
// An empty port still leaves a trailing colon, which the parser must cut at.
const optionalPort = fc.oneof(port, fc.constant(''));

const bracketedOrBare = fc.oneof(
  { weight: 1, arbitrary: ipAddress },
  { weight: 1, arbitrary: ipAddress.map((ip) => `[${ip}]`) },
);

// Socket address that the fallback may return. Undefined and empty both mean "no socket".
const socketAddress = fc.option(ipv4, { nil: undefined });

const xForwardedFor = fc.option(fc.string(), { nil: undefined });

describe('Feature: payments-api, Property 41: client IP parsing splits at the last colon, with a safe fallback', () => {
  it('returns everything before the last colon for IPv4:port and IPv6[:port] values', () => {
    fc.assert(
      fc.property(bracketedOrBare, optionalPort, socketAddress, (host, portValue, socket) => {
        const header = `${host}:${portValue}`;
        expect(deriveClientIp(header, socket)).toBe(host);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('uses the socket address when the header has no colon', () => {
    fc.assert(
      fc.property(fc.oneof(ipv4, fc.constant('')), socketAddress, (header, socket) => {
        expect(deriveClientIp(header, socket)).toBe(socket || UNKNOWN);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('uses the socket address when the header is absent', () => {
    fc.assert(
      fc.property(socketAddress, (socket) => {
        expect(deriveClientIp(undefined, socket)).toBe(socket || UNKNOWN);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('uses the socket address when the part before the last colon is empty', () => {
    fc.assert(
      fc.property(port, socketAddress, (portValue, socket) => {
        expect(deriveClientIp(`:${portValue}`, socket)).toBe(socket || UNKNOWN);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never lets a client-sent X-Forwarded-For header change the Client_IP', async () => {
    await fc.assert(
      fc.asyncProperty(
        bracketedOrBare,
        optionalPort,
        socketAddress,
        xForwardedFor,
        async (host, portValue, socket, forwardedFor) => {
          const viewer = `${host}:${portValue}`;
          const base = {
            headers: { 'cloudfront-viewer-address': viewer },
            socket: { remoteAddress: socket },
          };
          const withForwarded = {
            headers: { ...base.headers, 'x-forwarded-for': forwardedFor },
            socket: base.socket,
          };
          await expect(clientIpTracker(withForwarded)).resolves.toBe(await clientIpTracker(base));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
