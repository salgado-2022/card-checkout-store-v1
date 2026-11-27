import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { err, ok } from 'neverthrow';
import request from 'supertest';
import type { OriginSecretError, OriginSecretSource } from '../../config/origin-secret.provider';
import {
  OriginGuardMiddleware,
  type OriginGuardLogger,
  type OriginRejectionReason,
} from './origin-guard.middleware';
import type { RequestWithId } from './request-id.middleware';

const EXPECTED = 'expected-origin-secret-value';
const FORBIDDEN_BODY = {
  statusCode: 403,
  code: 'FORBIDDEN_ORIGIN',
  message: 'Origin not allowed.',
  details: [],
};

const sourceWith = (result: ReturnType<OriginSecretSource['get']>): OriginSecretSource => ({
  load: jest.fn(),
  get: () => result,
});

const makeLogger = () => ({ warn: jest.fn(), error: jest.fn() }) satisfies OriginGuardLogger;

function startServer(
  guard: OriginGuardMiddleware,
  requestId?: string,
): { server: Server; reached: jest.Mock } {
  const reached = jest.fn();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    (req as RequestWithId).requestId = requestId;
    guard.use(req as RequestWithId, res, () => {
      reached();
      res.end('handler');
    });
  });
  return { server, reached };
}

describe('OriginGuardMiddleware', () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const setup = (
    secret: ReturnType<OriginSecretSource['get']> = ok(EXPECTED),
    requestId = 'req-1',
  ) => {
    const logger = makeLogger();
    const started = startServer(new OriginGuardMiddleware(sourceWith(secret), logger), requestId);
    server = started.server;
    return { logger, reached: started.reached };
  };

  it('rejects a request without the header with 403 and the error envelope', async () => {
    const { logger, reached } = setup();

    const response = await request(server).get('/anything');

    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual(FORBIDDEN_BODY);
    expect(reached).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty header as missing', async () => {
    const { logger, reached } = setup();

    const response = await request(server).get('/').set('X-Origin-Verify', '');

    expect(response.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Origin rejected', {
      requestId: 'req-1',
      reason: 'missing_header',
    });
  });

  it('rejects a wrong header with 403 and reason invalid_header', async () => {
    const { logger, reached } = setup();

    const response = await request(server).post('/').set('X-Origin-Verify', 'wrong-secret-value');

    expect(response.status).toBe(403);
    expect(response.body).toEqual(FORBIDDEN_BODY);
    expect(reached).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Origin rejected', {
      requestId: 'req-1',
      reason: 'invalid_header',
    });
  });

  it('logs reason missing_header with the request id when the header is absent', async () => {
    const { logger } = setup(ok(EXPECTED), 'req-42');

    await request(server).get('/');

    expect(logger.warn).toHaveBeenCalledWith('Origin rejected', {
      requestId: 'req-42',
      reason: 'missing_header',
    });
  });

  it('calls next and does not respond when the header matches', async () => {
    const { logger, reached } = setup();

    const response = await request(server).get('/').set('X-Origin-Verify', EXPECTED);

    expect(response.status).toBe(200);
    expect(response.text).toBe('handler');
    expect(reached).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats a header whose value only differs in case as invalid', async () => {
    const { reached } = setup();

    const response = await request(server).get('/').set('X-Origin-Verify', EXPECTED.toUpperCase());

    expect(response.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('treats a repeated header as invalid even if one value is correct', async () => {
    const { logger, reached } = setup();
    // Node folds duplicate custom headers into one string, so the guard is also driven with a raw array.
    const res = {
      statusCode: 200,
      setHeader: jest.fn(),
      end: jest.fn(),
    } as unknown as ServerResponse;
    const guard = new OriginGuardMiddleware(sourceWith(ok(EXPECTED)), logger);
    const next = jest.fn();

    guard.use(
      {
        headers: { 'x-origin-verify': [EXPECTED, EXPECTED] },
        requestId: 'req-9',
      } as unknown as RequestWithId,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(logger.warn).toHaveBeenCalledWith('Origin rejected', {
      requestId: 'req-9',
      reason: 'invalid_header',
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it('never leaks the expected or received value in the body or in logs', async () => {
    const { logger } = setup();
    const received = 'received-secret-attempt';

    const response = await request(server).get('/').set('X-Origin-Verify', received);

    const serializedBody = JSON.stringify(response.body) + response.text;
    const serializedLogs = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    for (const text of [serializedBody, serializedLogs, JSON.stringify(response.headers)]) {
      expect(text).not.toContain(EXPECTED);
      expect(text).not.toContain(received);
    }
  });

  describe('when the secret is unavailable', () => {
    const unavailable: OriginSecretError = {
      kind: 'ORIGIN_SECRET_NOT_LOADED',
      parameterName: '/shop/origin/verify-secret',
      reason: 'load() has not completed',
    };

    it('fails closed with the 403 envelope, without calling next and without exposing details', async () => {
      const { logger, reached } = setup(err(unavailable));

      const response = await request(server).get('/').set('X-Origin-Verify', EXPECTED);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(FORBIDDEN_BODY);
      expect(response.text).not.toContain('/shop/origin');
      expect(reached).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
      const reason: OriginRejectionReason = 'secret_unavailable';
      expect(fields).toMatchObject({ requestId: 'req-1', reason });
      expect(JSON.stringify(fields)).not.toContain(EXPECTED);
    });
  });
});
