import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { toHttpException } from '../error-catalog';
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
  describe('framework HttpException mapping', () => {
    it('maps an unknown route (NotFoundException) to 404 ROUTE_NOT_FOUND without echoing the path', () => {
      const { status, body } = catchAndRespond(new NotFoundException('Cannot GET /secret/path'));

      expect(status).toHaveBeenCalledWith(404);
      expect(body).toEqual({
        statusCode: 404,
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found.',
        details: [],
      });
      expect(JSON.stringify(body)).not.toContain('secret/path');
    });

    it('maps a validation BadRequestException to 400 VALIDATION_ERROR with rule messages in details', () => {
      const { status, body } = catchAndRespond(
        new BadRequestException(['name must be a string', 'quantity must not be less than 1']),
      );

      expect(status).toHaveBeenCalledWith(400);
      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: ['name must be a string', 'quantity must not be less than 1'],
      });
    });

    it('maps a validation BadRequestException whose body is a plain string to 400 with no details', () => {
      const { body } = catchAndRespond(new BadRequestException('Bad input'));

      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: [],
      });
    });

    it('maps a string-bodied HttpException with status 429 to TOO_MANY_REQUESTS with the fixed message', () => {
      const { status, body } = catchAndRespond(new HttpException('Slow down', 429));

      expect(status).toHaveBeenCalledWith(429);
      expect(body).toEqual({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests.',
        details: [],
      });
    });

    it.each([
      ['UnauthorizedException', new UnauthorizedException('Bad credentials')],
      ['ForbiddenException', new ForbiddenException('Nope')],
      ['HttpException 418', new HttpException('Teapot', 418)],
      ['HttpException 502', new HttpException({ message: 'Upstream' }, 502)],
    ])(
      'maps %s, which has no catalog code, to 500 INTERNAL_ERROR without its message',
      (_label, exception) => {
        const { status, body, logger } = catchAndRespond(exception);

        expect(status).toHaveBeenCalledWith(500);
        expect(body).toEqual({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error.',
          details: [],
        });
        expect(logger.error).toHaveBeenCalledTimes(1);
      },
    );

    it('maps an HttpException with status 413 to PAYLOAD_TOO_LARGE with the fixed message', () => {
      const { body } = catchAndRespond(new HttpException('Too big', 413));

      expect(body).toEqual({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large.',
        details: [],
      });
    });

    it('maps an HttpException with status 415 to UNSUPPORTED_MEDIA_TYPE', () => {
      const { status, body } = catchAndRespond(new HttpException('Nope', 415));

      expect(status).toHaveBeenCalledWith(415);
      expect(body).toMatchObject({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });
  });

  describe('catalog exceptions', () => {
    it('passes a catalog envelope through unchanged', () => {
      const { status, body } = catchAndRespond(toHttpException({ kind: 'PRODUCT_NOT_FOUND' }));

      expect(status).toHaveBeenCalledWith(404);
      expect(body).toEqual({
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found.',
        details: [],
      });
    });

    it('logs the source kind of a catalog exception on the server side', () => {
      const { logger } = catchAndRespond(
        toHttpException({ kind: 'REPOSITORY_ERROR', reason: 'X' }),
      );

      expect(logger.error).toHaveBeenCalledWith('Request failed', {
        requestId: 'req-1',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        errorName: 'CatalogHttpException',
        kind: 'REPOSITORY_ERROR',
        errorMessage: 'Internal server error.',
      });
    });
  });

  describe('body-parser errors', () => {
    const bodyParserError = (type: string, message: string, status: number): Error =>
      Object.assign(new SyntaxError(message), { type, status, statusCode: status });

    it('maps entity.parse.failed to 400 VALIDATION_ERROR with a fixed message', () => {
      const original = 'Unexpected token h in JSON at position 7: {"card":"hunter2"';
      const { status, body, logger } = catchAndRespond(
        bodyParserError('entity.parse.failed', original, 400),
      );
      expect(status).toHaveBeenCalledWith(400);
      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Malformed JSON body.',
        details: [],
      });
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('hunter2');
      expect(logger.warn).toHaveBeenCalledWith('Request rejected', {
        requestId: 'req-1',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        errorName: 'SyntaxError',
      });
    });

    it('maps entity.too.large to 413 PAYLOAD_TOO_LARGE with a fixed message', () => {
      const original = 'request entity too large: 204800 > 102400 secret-detail';
      const { status, body, logger } = catchAndRespond(
        bodyParserError('entity.too.large', original, 413),
      );
      expect(status).toHaveBeenCalledWith(413);
      expect(body).toEqual({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large.',
        details: [],
      });
      expect(logger.error).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-detail');
    });

    it.each(['encoding.unsupported', 'charset.unsupported'])(
      'maps %s to 415 UNSUPPORTED_MEDIA_TYPE without echoing the original message',
      (type) => {
        const { status, body, logger } = catchAndRespond(
          bodyParserError(type, 'unsupported "x-secret-detail"', 415),
        );
        expect(status).toHaveBeenCalledWith(415);
        expect(body).toMatchObject({
          statusCode: 415,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          details: [],
        });
        expect(JSON.stringify(body)).not.toContain('secret-detail');
        expect(logger.error).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-detail');
      },
    );

    it.each(['request.aborted', 'request.size.invalid', 'parameters.too.many'])(
      'maps %s to 400 VALIDATION_ERROR with a fixed message',
      (type) => {
        const { status, body, logger } = catchAndRespond(
          bodyParserError(type, 'raw detail secret-detail', 400),
        );
        expect(status).toHaveBeenCalledWith(400);
        expect(body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Request body could not be read.',
          details: [],
        });
        expect(logger.error).not.toHaveBeenCalled();
      },
    );

    it('maps an untyped exposed 400 (failed decompression) to 400 VALIDATION_ERROR', () => {
      const zlibError = Object.assign(new Error('incorrect header check secret-detail'), {
        status: 400,
        statusCode: 400,
        expose: true,
      });
      const { status, body, logger } = catchAndRespond(zlibError);
      expect(status).toHaveBeenCalledWith(400);
      expect(body).toEqual({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request body could not be read.',
        details: [],
      });
      expect(logger.error).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-detail');
    });

    it('keeps an untyped 400 without expose, or an exposed non-400, as INTERNAL_ERROR', () => {
      const noExpose = Object.assign(new Error('x'), { status: 400 });
      const exposed500 = Object.assign(new Error('x'), { status: 500, expose: true });
      expect(catchAndRespond(noExpose).body).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(catchAndRespond(exposed500).body).toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('ignores other `type` values and treats the error as unknown', () => {
      const { status, body } = catchAndRespond(bodyParserError('something.else', 'boom', 400));
      expect(status).toHaveBeenCalledWith(500);
      expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('does not fail on null or primitive exceptions', () => {
      expect(catchAndRespond(null).body).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(catchAndRespond(undefined).body).toMatchObject({ code: 'INTERNAL_ERROR' });
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
      ['catalog exception', toHttpException({ kind: 'INSUFFICIENT_STOCK', available: 0 })],
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
        code: 'ROUTE_NOT_FOUND',
        errorName: 'NotFoundException',
      });
    });

    it('never logs the message of a 4xx error, which may echo client input', () => {
      const { logger } = catchAndRespond(new BadRequestException('field "password" was hunter2'), {
        requestId: 'r',
      });
      const [, fields] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(Object.keys(fields).sort()).toEqual(['code', 'errorName', 'requestId', 'statusCode']);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('hunter2');
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
    throw toHttpException({ kind: 'PRODUCT_NOT_FOUND' });
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

  it('answers an unknown route with the 404 ROUTE_NOT_FOUND envelope and no echoed path', async () => {
    const response = await request(app.getHttpServer()).get('/unknown-route-xyz');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found.',
      details: [],
    });
    expect(response.text).not.toContain('unknown-route-xyz');
    expect(response.body).not.toHaveProperty('stack');
  });

  it('answers a thrown catalog exception with its status and envelope', async () => {
    const response = await request(app.getHttpServer()).get('/filter-probe/not-found');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'PRODUCT_NOT_FOUND',
      message: 'Product not found.',
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
