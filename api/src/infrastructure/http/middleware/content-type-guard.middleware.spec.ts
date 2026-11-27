import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, HttpCode, Module, Post, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsInt, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ResultExceptionFilter } from '../filters/result-exception.filter';
import { JsonLogger } from '../logging/json-logger';
import { createValidationPipe } from '../validation-pipe';
import { preserveBodyParseFailure } from './body-parser-error.middleware';
import {
  contentTypeGuardMiddleware,
  hasRequestBody,
  parseContentType,
} from './content-type-guard.middleware';
import { RequestIdMiddleware, type RequestWithId } from './request-id.middleware';

class ShippingDto {
  @IsString()
  @MinLength(5)
  addressLine1!: string;
}

class EchoDto {
  @IsString()
  @MinLength(3)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  quantity!: number;

  @ValidateNested()
  @Type(() => ShippingDto)
  shipping?: ShippingDto;
}

@Controller('echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

const silentLogger = (): JsonLogger => {
  const output = { write: (): boolean => true };
  return new JsonLogger({ stdout: output, stderr: output });
};

async function createMinimalApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(EchoModule, { logger: false });
  const requestId = new RequestIdMiddleware();
  app.use((req: RequestWithId, res: ServerResponse, next: () => void) =>
    requestId.use(req, res, next),
  );
  app.use(contentTypeGuardMiddleware);
  app.useBodyParser('json');
  app.use(preserveBodyParseFailure);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(silentLogger()));
  await app.init();
  return app;
}

const VALID_BODY = { name: 'Juan', quantity: 2 };

describe('contentTypeGuardMiddleware (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createMinimalApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['Application/JSON; Charset=UTF-8'],
    ['application/json; charset="utf-8"'],
  ])('lets a POST with Content-Type %s reach the handler', async (contentType) => {
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', contentType)
      .send(VALID_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(VALID_BODY);
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['application/jsonx', 'application/jsonx'],
    ['application/json; charset=latin1', 'application/json; charset=latin1'],
    ['multipart/form-data', 'multipart/form-data; boundary=x'],
  ])('answers 415 UNSUPPORTED_MEDIA_TYPE for Content-Type %s', async (_label, contentType) => {
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', contentType)
      .send('name=Juan');

    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported media type. Use application/json.',
      details: [],
    });
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('answers 415 for a POST with a body and no Content-Type header', async () => {
    const response = await request(server())
      .post('/echo')
      .unset('Content-Type')
      .set('Content-Length', '18')
      .send(Buffer.from('{"name":"Juan"}'))
      .buffer(true);

    expect(response.status).toBe(415);
    expect(response.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('does not answer 415 for a POST without a body', async () => {
    const response = await request(server()).post('/echo').unset('Content-Type');

    expect(response.status).not.toBe(415);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('answers 400 VALIDATION_ERROR with one details entry per failed rule', async () => {
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ name: 'Al', quantity: 9 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: expect.arrayContaining(['name: minLength', 'quantity: max']),
    });
    expect(response.body.details).toHaveLength(2);
  });

  it('names nested fields with a dotted path', async () => {
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ ...VALID_BODY, shipping: { addressLine1: 'abc' } });

    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(['shipping.addressLine1: minLength']);
  });

  it('rejects an unknown property with forbidNonWhitelisted', async () => {
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ ...VALID_BODY, amountInCents: 1 });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.details).toEqual(['amountInCents: whitelistValidation']);
  });

  it('answers 400 MALFORMED body with the fixed message and no parser detail', async () => {
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"name": "hunter2"');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Malformed JSON body.');
    expect(response.text).not.toContain('hunter2');
  });

  it('sends X-Request-Id on every error response', async () => {
    const unsupported = await request(server())
      .post('/echo')
      .set('Content-Type', 'text/plain')
      .send('x');
    const invalid = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({});
    const notFound = await request(server()).get('/missing');

    for (const response of [unsupported, invalid, notFound]) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['x-request-id']).toMatch(/\S+/);
    }
  });
});

describe('parseContentType', () => {
  it.each([
    ['application/json', 'application/json', []],
    ['  Application/JSON ; Charset = "UTF-8" ', 'application/json', ['utf-8']],
    ['application/json; charset="a;b"', 'application/json', ['a;b']],
    ['application/json; charset="x\\"y"', 'application/json', ['x"y']],
    ['application/json; foo', 'application/json', []],
    ['application/json; charset=utf-8; charset=latin1', 'application/json', ['utf-8', 'latin1']],
    ['', '', []],
  ])('parses %j into media type %j and charsets %j', (header, mediaType, charsets) => {
    expect(parseContentType(header)).toEqual({ mediaType, charsets });
  });
});

describe('hasRequestBody', () => {
  const withHeaders = (headers: Record<string, string>): IncomingMessage =>
    ({ headers }) as unknown as IncomingMessage;

  it.each([
    [{ 'transfer-encoding': 'chunked' }, true],
    [{ 'content-length': '12' }, true],
    [{ 'content-length': 'not-a-number' }, true],
    [{ 'content-length': '0' }, false],
    [{}, false],
  ])('returns the body flag for headers %j', (headers, expected) => {
    expect(hasRequestBody(withHeaders(headers))).toBe(expected);
  });
});
