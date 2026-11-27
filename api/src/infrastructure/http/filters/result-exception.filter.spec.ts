import type { ArgumentsHost } from '@nestjs/common';
import {
  BadGatewayException,
  BadRequestException,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ResultExceptionFilter } from './result-exception.filter';

interface FakeLogger {
  warn: jest.Mock;
  error: jest.Mock;
}

function createLogger(): FakeLogger {
  return { warn: jest.fn(), error: jest.fn() };
}

function createHost(req: { requestId?: string } = { requestId: 'req-1' }): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status };
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function catchAndRespond(
  exception: unknown,
  req?: { requestId?: string },
): { status: jest.Mock; json: jest.Mock; logger: FakeLogger; body: Record<string, unknown> } {
  const logger = createLogger();
  const { host, status, json } = createHost(req);
  new ResultExceptionFilter(logger).catch(exception, host);
  const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
  return { status, json, logger, body };
}

describe('ResultExceptionFilter', () => {
  describe('HttpException mapping', () => {
    it('maps NotFoundException to 404 NOT_FOUND and keeps its message', () => {
      const { status, body } = catchAndRespond(new NotFoundException('Cannot GET /x'));

      expect(status).toHaveBeenCalledWith(404);
      expect(body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Cannot GET /x',
        details: [],
      });
    });

    it('maps a validation BadRequestException to 400 VALIDATION_ERROR with rule messages in details', () => {
      const { status, body } = catchAndRespond(
        new BadRequestException(['name must be a string', 'quantity must not be less than 1']),
      );

      expect(status).toHaveBeenCalledWith(400);
      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Bad Request Exception',
        details: ['name must be a string', 'quantity must not be less than 1'],
      });
    });

    it('maps UnauthorizedException to 401 UNAUTHORIZED', () => {
      const { status, body } = catchAndRespond(new UnauthorizedException('Bad credentials'));

      expect(status).toHaveBeenCalledWith(401);
      expect(body).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Bad credentials',
      });
    });

    it('maps ForbiddenException to 403 FORBIDDEN', () => {
      const { status, body } = catchAndRespond(new ForbiddenException('Nope'));

      expect(status).toHaveBeenCalledWith(403);
      expect(body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN', message: 'Nope' });
    });

    it('maps ConflictException to 409 CONFLICT', () => {
      const { status, body } = catchAndRespond(new ConflictException('Already exists'));

      expect(status).toHaveBeenCalledWith(409);
      expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT', message: 'Already exists' });
    });

    it('maps UnprocessableEntityException to 422 UNPROCESSABLE_ENTITY', () => {
      const { status, body } = catchAndRespond(new UnprocessableEntityException('Reused key'));

      expect(status).toHaveBeenCalledWith(422);
      expect(body).toMatchObject({
        statusCode: 422,
        code: 'UNPROCESSABLE_ENTITY',
        message: 'Reused key',
      });
    });

    it('maps a string-bodied HttpException with status 429 to TOO_MANY_REQUESTS', () => {
      const { status, body } = catchAndRespond(new HttpException('Slow down', 429));

      expect(status).toHaveBeenCalledWith(429);
      expect(body).toEqual({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
        message: 'Slow down',
        details: [],
      });
    });

    it('maps BadGatewayException to 502 BAD_GATEWAY', () => {
      const { status, body } = catchAndRespond(new BadGatewayException('Upstream failed'));

      expect(status).toHaveBeenCalledWith(502);
      expect(body).toMatchObject({
        statusCode: 502,
        code: 'BAD_GATEWAY',
        message: 'Upstream failed',
      });
    });

    it('maps an HttpException with an unlisted status to HTTP_ERROR and keeps the status', () => {
      const { status, body } = catchAndRespond(new HttpException('Teapot', 418));

      expect(status).toHaveBeenCalledWith(418);
      expect(body).toMatchObject({ statusCode: 418, code: 'HTTP_ERROR', message: 'Teapot' });
    });

    it('uses the exception message when an object body has no message field', () => {
      const exception = new HttpException({ reason: 'x' }, 418);
      const { body } = catchAndRespond(exception);

      expect(body).toEqual({
        statusCode: 418,
        code: 'HTTP_ERROR',
        message: exception.message,
        details: [],
      });
    });

    it('uses the exception message when the object body message is neither a string nor an array', () => {
      const exception = new HttpException({ message: 42 }, 418);
      const { body } = catchAndRespond(exception);

      expect(body).toEqual({
        statusCode: 418,
        code: 'HTTP_ERROR',
        message: exception.message,
        details: [],
      });
    });
  });

  describe('unknown errors', () => {
    it('maps an Error to 500 INTERNAL_ERROR with a generic message and never echoes the original message', () => {
      const { status, body } = catchAndRespond(new Error('password=hunter2 in table X'));

      expect(status).toHaveBeenCalledWith(500);
      expect(body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: [],
      });
      expect(JSON.stringify(body)).not.toContain('hunter2');
    });

    it('maps a thrown non-Error value to 500 INTERNAL_ERROR', () => {
      const { status, body } = catchAndRespond('boom');

      expect(status).toHaveBeenCalledWith(500);
      expect(body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
    });
  });

  describe('response envelope', () => {
    it.each([
      ['HttpException', new NotFoundException('missing')],
      ['unknown Error', new Error('kaboom')],
    ])('returns exactly the four envelope keys without stack for %s', (_label, exception) => {
      const { body } = catchAndRespond(exception);

      expect(Object.keys(body).sort()).toEqual(['code', 'details', 'message', 'statusCode']);
      expect(body).not.toHaveProperty('stack');
      expect(JSON.stringify(body)).not.toContain('at ');
    });
  });

  describe('server-side logging', () => {
    it('logs an unknown error as error with requestId, name and message but no stack', () => {
      const error = new TypeError('cannot read thing');
      const { logger } = catchAndRespond(error, { requestId: 'req-42' });

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [message, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toBe('Request failed');
      expect(fields).toEqual({
        requestId: 'req-42',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        errorName: 'TypeError',
        errorMessage: 'cannot read thing',
      });
      expect(JSON.stringify(fields)).not.toContain(error.stack ?? '__no_stack__');
    });

    it('logs a 4xx HttpException as warn and omits requestId when the request has none', () => {
      const { logger } = catchAndRespond(new NotFoundException('missing'), {});

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Request rejected', {
        requestId: undefined,
        statusCode: 404,
        code: 'NOT_FOUND',
        errorName: 'NotFoundException',
        errorMessage: 'missing',
      });
    });

    it('logs a non-Error value with placeholder name and message', () => {
      const { logger } = catchAndRespond({ secret: 'do-not-log' }, { requestId: 'r' });

      const [, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
      expect(fields).toMatchObject({
        errorName: 'NonErrorThrown',
        errorMessage: 'Non-Error value thrown',
      });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('do-not-log');
    });
  });

  describe('default logger', () => {
    it('writes a JSON line to stderr when no logger is injected', () => {
      const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const { host, json } = createHost({ requestId: 'default-1' });
        new ResultExceptionFilter().catch(new Error('x'), host);

        expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
        const line = write.mock.calls[0]?.[0] as string;
        expect(JSON.parse(line)).toMatchObject({
          level: 'error',
          requestId: 'default-1',
          errorName: 'Error',
        });
      } finally {
        write.mockRestore();
      }
    });
  });
});

@Controller('filter-probe')
class FilterProbeController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('Product not found');
  }

  @Get('crash')
  crash(): never {
    throw new Error('internal detail that must not leak');
  }
}

describe('ResultExceptionFilter over HTTP', () => {
  let app: INestApplication;
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeAll(async () => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const moduleRef = await Test.createTestingModule({
      controllers: [FilterProbeController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = 'http-req-1';
      next();
    });
    app.useGlobalFilters(new ResultExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it('answers an unknown route with the 404 NOT_FOUND envelope', async () => {
    const response = await request(app.getHttpServer()).get('/unknown-route');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', details: [] });
    expect(response.body).not.toHaveProperty('stack');
  });

  it('answers a thrown HttpException with its status and envelope', async () => {
    const response = await request(app.getHttpServer()).get('/filter-probe/not-found');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Product not found',
      details: [],
    });
  });

  it('answers an unexpected crash with 500 INTERNAL_ERROR and no internals', async () => {
    const response = await request(app.getHttpServer()).get('/filter-probe/crash');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
      details: [],
    });
    expect(response.text).not.toContain('internal detail');
    expect(response.text).not.toContain('stack');
  });

  it('logs the request id from the request, not the response body', async () => {
    await request(app.getHttpServer()).get('/filter-probe/crash');

    const line = stderr.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes('Request failed'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ requestId: 'http-req-1', errorName: 'Error' });
  });
});
