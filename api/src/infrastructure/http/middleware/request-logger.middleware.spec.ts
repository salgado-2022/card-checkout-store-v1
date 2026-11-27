import { EventEmitter } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import request from 'supertest';
import { JsonLogger, type LogOutput } from '../logging/json-logger';
import { RequestIdMiddleware, type RequestWithId } from './request-id.middleware';
import { RequestLoggerMiddleware } from './request-logger.middleware';

class MemoryOutput implements LogOutput {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const REQUIRED_KEYS = ['durationMs', 'method', 'path', 'requestId', 'statusCode'];

function createLogger(): { logger: JsonLogger; stdout: MemoryOutput } {
  const stdout = new MemoryOutput();
  const logger = new JsonLogger({ stdout, stderr: new MemoryOutput() });
  return { logger, stdout };
}

// Runs the request id middleware before the request logger, in the order the app will use.
function createApp(
  logger: JsonLogger,
  route: (req: RequestWithId, res: ServerResponse) => void,
): Server {
  const requestId = new RequestIdMiddleware();
  const requestLogger = new RequestLoggerMiddleware(logger);
  return createServer((req, res) => {
    const typed = req as RequestWithId;
    requestId.use(typed, res, () => {
      requestLogger.use(typed, res, () => route(typed, res));
    });
  });
}

function parseLogLines(output: MemoryOutput): Record<string, unknown>[] {
  return output.chunks.flatMap((chunk) =>
    chunk
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe('RequestLoggerMiddleware', () => {
  let server: Server | undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it('writes one JSON line with requestId, method, path, statusCode and durationMs', async () => {
    const { logger, stdout } = createLogger();
    server = createApp(logger, (_req, res) => {
      res.statusCode = 201;
      res.end('ok');
    });

    await request(server).get('/api/v1/products').set('X-Request-Id', 'req-123456');

    const lines = parseLogLines(stdout);
    expect(lines).toHaveLength(1);
    const [entry] = lines;
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        'durationMs',
        'level',
        'message',
        'method',
        'path',
        'requestId',
        'statusCode',
        'time',
      ].sort(),
    );
    expect(entry).toMatchObject({
      level: 'info',
      requestId: 'req-123456',
      method: 'GET',
      path: '/api/v1/products',
      statusCode: 201,
    });
    expect(typeof entry?.durationMs).toBe('number');
    expect(Number(entry?.durationMs)).toBeGreaterThanOrEqual(0);
  });

  it('logs only after the response has finished', async () => {
    const { logger, stdout } = createLogger();
    let linesBeforeEnd = -1;
    server = createApp(logger, (_req, res) => {
      linesBeforeEnd = stdout.chunks.length;
      res.end('ok');
    });

    await request(server).get('/');

    expect(linesBeforeEnd).toBe(0);
    expect(stdout.chunks).toHaveLength(1);
  });

  it('omits the query string from the logged path', async () => {
    const { logger, stdout } = createLogger();
    server = createApp(logger, (_req, res) => res.end('ok'));

    await request(server).get('/api/v1/products?token=query-secret&page=2');

    const [entry] = parseLogLines(stdout);
    expect(entry?.path).toBe('/api/v1/products');
    expect(stdout.chunks.join('')).not.toContain('query-secret');
  });

  it('never writes the x-origin-verify value or any other header', async () => {
    const { logger, stdout } = createLogger();
    server = createApp(logger, (_req, res) => res.end('ok'));

    await request(server)
      .get('/api/v1/health')
      .set('x-origin-verify', 'secret-value')
      .set('authorization', 'Bearer header-secret');

    const output = stdout.chunks.join('');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('header-secret');
    expect(output).not.toMatch(/x-origin-verify|authorization/i);
    const [entry] = parseLogLines(stdout);
    expect(Object.keys(entry ?? {})).not.toEqual(expect.arrayContaining(['headers']));
  });

  it('logs "unknown" as request id when the request id middleware did not run', async () => {
    const { logger, stdout } = createLogger();
    const requestLogger = new RequestLoggerMiddleware(logger);
    server = createServer((req, res) => {
      requestLogger.use(req as RequestWithId, res, () => res.end('ok'));
    });

    await request(server).get('/');

    const [entry] = parseLogLines(stdout);
    expect(entry?.requestId).toBe('unknown');
    expect(REQUIRED_KEYS.every((key) => key in (entry ?? {}))).toBe(true);
  });

  it('falls back to UNKNOWN method and "/" path when the request has neither', () => {
    const { logger, stdout } = createLogger();
    const middleware = new RequestLoggerMiddleware(logger);
    const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
    const req = { headers: {} } as unknown as RequestWithId;

    middleware.use(req, res, () => undefined);
    res.emit('finish');

    expect(parseLogLines(stdout)[0]).toMatchObject({
      method: 'UNKNOWN',
      path: '/',
      requestId: 'unknown',
    });
  });

  it('calls next exactly once and does not log before the response finishes', () => {
    const { logger, stdout } = createLogger();
    const middleware = new RequestLoggerMiddleware(logger);
    const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
    const req = {
      headers: {},
      method: 'POST',
      url: '/api/v1/transactions',
    } as unknown as RequestWithId;
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(stdout.chunks).toHaveLength(0);
    res.emit('finish');
    expect(parseLogLines(stdout)).toHaveLength(1);
  });
});
