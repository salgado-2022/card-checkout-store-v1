import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { RequestIdMiddleware, type RequestWithId } from './request-id.middleware';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Serves one request through the middleware and echoes the id seen by the handler.
function startServer(middleware: RequestIdMiddleware): Server {
  return createServer((req, res) => {
    middleware.use(req as RequestWithId, res, () => {
      res.end((req as RequestWithId).requestId ?? '');
    });
  });
}

describe('RequestIdMiddleware', () => {
  let server: Server;

  beforeEach(() => {
    server = startServer(new RequestIdMiddleware());
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reuses the incoming X-Request-Id header on request and response', async () => {
    const randomUUID = jest.spyOn(crypto, 'randomUUID');

    const response = await request(server).get('/').set('X-Request-Id', 'client-id-123');

    expect(response.headers['x-request-id']).toBe('client-id-123');
    expect(response.text).toBe('client-id-123');
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it('accepts ids at the 8 and 64 character limits', async () => {
    const shortest = 'abcd-1.2';
    const longest = 'A'.repeat(64);

    const short = await request(server).get('/').set('X-Request-Id', shortest);
    const long = await request(server).get('/').set('X-Request-Id', longest);

    expect(short.headers['x-request-id']).toBe(shortest);
    expect(long.headers['x-request-id']).toBe(longest);
  });

  it.each([
    ['shorter than 8 characters', 'short-1'],
    ['longer than 64 characters', 'a'.repeat(65)],
    ['containing a space', 'client id 123'],
    ['containing a slash', 'client/id/123'],
    ['containing a colon', 'client:id:123'],
    ['containing non-ASCII letters', 'cliente-ñandú'],
  ])('replaces an incoming id %s with a generated UUID', async (_label, incoming) => {
    const randomUUID = jest.spyOn(crypto, 'randomUUID');

    const response = await request(server).get('/').set('X-Request-Id', incoming);

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
    expect(response.headers['x-request-id']).not.toBe(incoming);
    expect(response.text).toBe(response.headers['x-request-id']);
  });

  it('generates a request id with crypto.randomUUID when the header is absent', async () => {
    const randomUUID = jest.spyOn(crypto, 'randomUUID');

    const response = await request(server).get('/');

    expect(randomUUID).toHaveBeenCalledTimes(1);
    const generated = randomUUID.mock.results[0]?.value;
    expect(generated).toMatch(UUID_PATTERN);
    expect(response.headers['x-request-id']).toBe(generated);
    expect(response.text).toBe(generated);
  });

  it('generates a request id when the header is present but empty', async () => {
    const randomUUID = jest.spyOn(crypto, 'randomUUID');

    const response = await request(server).get('/').set('X-Request-Id', '');

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('generates a non-empty id on each request when the header is absent', async () => {
    const first = await request(server).get('/');
    const second = await request(server).get('/');

    expect(first.headers['x-request-id']).not.toBe('');
    expect(second.headers['x-request-id']).not.toBe('');
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('calls next exactly once', () => {
    const middleware = new RequestIdMiddleware();
    const next = jest.fn();
    const req = { headers: {} } as unknown as RequestWithId;
    const res = { setHeader: jest.fn() } as unknown as Parameters<RequestIdMiddleware['use']>[1];

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.requestId).toMatch(UUID_PATTERN);
  });
});
