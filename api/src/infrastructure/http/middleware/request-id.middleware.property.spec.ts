import { createServer, type Server } from 'node:http';
import * as fc from 'fast-check';
import request from 'supertest';
import {
  REQUEST_ID_PATTERN,
  RequestIdMiddleware,
  type RequestWithId,
} from './request-id.middleware';

// Feature: platform-foundation, Property 4: Request-Id propagation
// Validates: Requirements 8.4, 9.1, 9.6

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Visible ASCII characters (0x21..0x7E): the only bytes that are valid in an HTTP header value.
const visibleAsciiChar = fc
  .integer({ min: 0x21, max: 0x7e })
  .map((code) => String.fromCharCode(code));

const visibleAsciiHeader = fc
  .array(visibleAsciiChar, { minLength: 1, maxLength: 128 })
  .map((chars) => chars.join(''));

// Valid ids: 8 to 64 characters from [A-Za-z0-9._-]. The server must echo them unchanged.
const validRequestId = fc.stringMatching(/^[A-Za-z0-9._-]{8,64}$/);

// Invalid ids: any visible ASCII value that the pattern rejects (wrong length or characters).
const invalidRequestId = visibleAsciiHeader.filter((value) => !REQUEST_ID_PATTERN.test(value));

// Either an absent header (undefined) or a visible ASCII value, valid or not.
const incomingHeader = fc.option(fc.oneof(validRequestId, invalidRequestId), { nil: undefined });

const NUM_RUNS = 100;

describe('Feature: platform-foundation, Property 4: Request-Id propagation', () => {
  let server: Server;
  let handlerSawRequestId: string | undefined;

  beforeAll(async () => {
    const middleware = new RequestIdMiddleware();
    server = createServer((req, res) => {
      middleware.use(req as RequestWithId, res, () => {
        handlerSawRequestId = (req as RequestWithId).requestId;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ seenByHandler: handlerSawRequestId ?? null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    handlerSawRequestId = undefined;
  });

  it('always returns a non-empty X-Request-Id and the handler sees the same value', async () => {
    await fc.assert(
      fc.asyncProperty(incomingHeader, async (header) => {
        handlerSawRequestId = undefined;
        const agent = request(server).get('/');
        const response = await (header === undefined ? agent : agent.set('X-Request-Id', header));

        const responseId = response.headers['x-request-id'];
        expect(typeof responseId).toBe('string');
        expect(responseId).not.toBe('');
        const body = response.body as { seenByHandler: string | null };
        expect(body.seenByHandler).toBe(responseId);
        expect(handlerSawRequestId).toBe(responseId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('echoes a valid incoming X-Request-Id unchanged in the response and the handler', async () => {
    await fc.assert(
      fc.asyncProperty(validRequestId, async (header) => {
        handlerSawRequestId = undefined;
        const response = await request(server).get('/').set('X-Request-Id', header);

        expect(response.headers['x-request-id']).toBe(header);
        expect(handlerSawRequestId).toBe(header);
        expect((response.body as { seenByHandler: string | null }).seenByHandler).toBe(header);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('replaces an invalid incoming X-Request-Id with a generated UUID', async () => {
    await fc.assert(
      fc.asyncProperty(invalidRequestId, async (header) => {
        handlerSawRequestId = undefined;
        const response = await request(server).get('/').set('X-Request-Id', header);

        const responseId = response.headers['x-request-id'];
        expect(responseId).toMatch(UUID_PATTERN);
        expect(responseId).not.toBe(header);
        expect(handlerSawRequestId).toBe(responseId);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
