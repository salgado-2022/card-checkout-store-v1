import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import request from 'supertest';
import type { OriginSecretSource } from '../../config/origin-secret.provider';
import {
  ORIGIN_VERIFY_HEADER,
  OriginGuardMiddleware,
  type OriginGuardLogger,
} from './origin-guard.middleware';
import type { RequestWithId } from './request-id.middleware';

const SECRET = 'expected-origin-secret-value';
const REQUEST_ID = 'req-property';
const NUM_RUNS = 100;
const PROPERTY_TIMEOUT_MS = 60_000;

const FORBIDDEN_BODY = {
  statusCode: 403,
  code: 'FORBIDDEN_ORIGIN',
  message: 'Origin not allowed.',
  details: [],
};
const FORBIDDEN_BODY_TEXT = JSON.stringify(FORBIDDEN_BODY);

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options'] as const;
type Method = (typeof METHODS)[number];

// HEAD is excluded on purpose: a HEAD response has no body, so the envelope cannot be checked.
const method = fc.constantFrom(...METHODS);

// Unreserved URI characters only, so every generated path is valid in an HTTP request line.
const PATH_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~'.split(
  '',
);
const pathCharacter = fc.constantFrom(...PATH_CHARACTERS);
const pathSegment = fc.array(pathCharacter, { minLength: 1, maxLength: 12 }).map((c) => c.join(''));
const randomPath = fc
  .array(pathSegment, { minLength: 0, maxLength: 4 })
  .map((segments) => `/${segments.join('/')}`);
const knownOrUnknownPath = fc.constantFrom(
  '/',
  '/api/v1/health',
  '/api/v1/products',
  '/api/v1/transactions',
  '/api/v1/unknown-route',
);
const basePath = fc.oneof(knownOrUnknownPath, randomPath);
const requestPath = fc
  .tuple(basePath, fc.option(pathSegment, { nil: undefined }))
  .map(([path, query]) => (query === undefined ? path : `${path}?${query}`));

// Visible ASCII (0x21..0x7E) only. Spaces are excluded because Node trims them at the edges.
const headerCharacter = fc
  .integer({ min: 0x21, max: 0x7e })
  .map((code) => String.fromCharCode(code));
const visibleAsciiHeader = fc
  .array(headerCharacter, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(''));

// Values that look like the secret but differ by one edit: case, truncation, prefix or suffix.
const nearSecret = fc.constantFrom(
  SECRET.toUpperCase(),
  SECRET.slice(0, -1),
  `${SECRET}x`,
  `x${SECRET}`,
  SECRET.replace('-', '_'),
);

// Every header value that the guard must reject: absent, empty, random, or a near-miss secret.
const wrongHeader = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constant(''),
  visibleAsciiHeader.filter((value) => value !== SECRET),
  nearSecret,
);

const makeLogger = () => ({ warn: jest.fn(), error: jest.fn() }) satisfies OriginGuardLogger;

// The response body must never contain the secret or the header value that was sent.
// A received value that also appears inside the fixed envelope would match on its own,
// so the leak check skips those values. The exact-envelope check already covers them.
function assertNoLeak(text: string, received: string | undefined): void {
  expect(text).not.toContain(SECRET);
  if (received !== undefined && received !== '' && !FORBIDDEN_BODY_TEXT.includes(received)) {
    expect(text).not.toContain(received);
  }
}

describe('OriginGuardMiddleware property tests', () => {
  const probe = jest.fn();
  const logger = makeLogger();
  const secretSource: OriginSecretSource = { load: jest.fn(), get: () => ok(SECRET) };
  const guard = new OriginGuardMiddleware(secretSource, logger);

  let server: Server;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      (req as RequestWithId).requestId = REQUEST_ID;
      guard.use(req as RequestWithId, res, () => {
        probe();
        res.statusCode = 200;
        res.end('handler');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    probe.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  const send = (verb: Method, path: string, headerValue: string | undefined) => {
    const test = request(server)[verb](path);
    return headerValue === undefined ? test : test.set(ORIGIN_VERIFY_HEADER, headerValue);
  };

  describe('Feature: platform-foundation, Property 1: Origin guard rejects every request without a valid secret', () => {
    // Validates: Requirements 9.1, 9.2, 9.5, 9.6
    it(
      'answers 403 with the exact envelope, leaks no secret value and never calls the handler',
      async () => {
        await fc.assert(
          fc.asyncProperty(method, requestPath, wrongHeader, async (verb, path, value) => {
            probe.mockClear();
            logger.warn.mockClear();

            const response = await send(verb, path, value);

            expect(response.status).toBe(403);
            expect(response.headers['content-type']).toContain('application/json');
            expect(response.body).toEqual(FORBIDDEN_BODY);
            assertNoLeak(response.text, value);
            expect(probe).not.toHaveBeenCalled();

            const expectedReason =
              value === undefined || value === '' ? 'missing_header' : 'invalid_header';
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledWith('Origin rejected', {
              requestId: REQUEST_ID,
              reason: expectedReason,
            });
          }),
          { numRuns: NUM_RUNS },
        );
      },
      PROPERTY_TIMEOUT_MS,
    );
  });

  describe('Feature: platform-foundation, Property 2: Origin guard passes through on a valid secret', () => {
    // Validates: Requirements 9.3
    it(
      'calls the handler exactly once and does not short-circuit the request',
      async () => {
        await fc.assert(
          fc.asyncProperty(method, requestPath, async (verb, path) => {
            probe.mockClear();
            logger.warn.mockClear();

            const response = await send(verb, path, SECRET);

            expect(response.status).toBe(200);
            expect(response.text).toBe('handler');
            expect(probe).toHaveBeenCalledTimes(1);
            expect(logger.warn).not.toHaveBeenCalled();
            expect(logger.error).not.toHaveBeenCalled();
          }),
          { numRuns: NUM_RUNS },
        );
      },
      PROPERTY_TIMEOUT_MS,
    );
  });
});
