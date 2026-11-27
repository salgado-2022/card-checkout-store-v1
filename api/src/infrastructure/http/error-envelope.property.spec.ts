import type { Server } from 'node:http';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import * as fc from 'fast-check';
import request from 'supertest';
import { TEST_ORIGIN_SECRET, createHttpPipelineApp } from '../../../test/support/http-pipeline-app';
import { CatalogHttpException, ERROR_CATALOG, type ErrorCode, envelopeFor } from './error-catalog';

const NUM_RUNS = 25;
const CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

// Adversarial request values. Alphanumeric so they are valid in a path, a header and a JSON string.
// The marker prefix makes a leak easy to spot: it cannot occur in any fixed catalog message.
const adversarial = fc.stringMatching(/^adv[A-Za-z0-9]{12,24}$/);

class ProbeDto {
  @IsString()
  @MinLength(3)
  name!: string;
}

// Test-only controller. It lives in this spec, never in production code. Codes that no route
// returns yet are simulated: the controller throws the catalog envelope for the requested code.
@Controller('probe')
class ProbeController {
  @Post('dto')
  @HttpCode(200)
  dto(@Body() body: ProbeDto): ProbeDto {
    return body;
  }

  @Post('simulate/:code')
  @HttpCode(200)
  simulate(@Param('code') code: string): never {
    if (!Object.hasOwn(ERROR_CATALOG, code)) {
      throw new CatalogHttpException(envelopeFor('ROUTE_NOT_FOUND'), 'PROBE');
    }
    throw new CatalogHttpException(envelopeFor(code as ErrorCode), 'PROBE');
  }

  @Get('throw/:detail')
  boom(@Param('detail') detail: string): never {
    // An unexpected error whose message carries request data must never reach the body.
    throw new Error(detail);
  }
}

type Send = (server: Server, value: string) => request.Test;

const withOrigin = (test: request.Test): request.Test =>
  test.set('X-Origin-Verify', TEST_ORIGIN_SECRET);

// Each trigger drives a real request path when one exists. The rest use the simulate route.
// A trigger for a code is optional: codes without one fall back to the simulated route, so a
// new catalog code is covered automatically.
const TRIGGERS: Partial<Record<ErrorCode, Send>> = {
  VALIDATION_ERROR: (server, value) =>
    withOrigin(request(server).post('/api/v1/probe/dto'))
      .set('Content-Type', 'application/json')
      .send({ name: 'ok', extra: value }),
  FORBIDDEN_ORIGIN: (server, value) =>
    request(server).get(`/api/v1/probe/throw/${value}`).set('X-Origin-Verify', value),
  ROUTE_NOT_FOUND: (server, value) => withOrigin(request(server).get(`/api/v1/${value}`)),
  PAYLOAD_TOO_LARGE: (server, value) =>
    withOrigin(request(server).post('/api/v1/probe/dto'))
      .set('Content-Type', 'application/json')
      .send({ name: `${'x'.repeat(120_000)}${value}` }),
  UNSUPPORTED_MEDIA_TYPE: (server, value) =>
    withOrigin(request(server).post('/api/v1/probe/dto'))
      .set('Content-Type', 'text/plain')
      .send(value),
  INTERNAL_ERROR: (server, value) =>
    withOrigin(request(server).get(`/api/v1/probe/throw/${value}`)),
};

function simulated(code: ErrorCode): Send {
  return (server, value) =>
    withOrigin(request(server).post(`/api/v1/probe/simulate/${code}`))
      .query({ q: value })
      .set('Content-Type', 'application/json')
      .send({ extra: value });
}

describe('Feature: payments-api, Property 36: Every error response uses the fixed envelope and the documented status', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createHttpPipelineApp({ controllers: [ProbeController] });
  });

  afterAll(async () => {
    await app.close();
  });

  const server = (): Server => app.getHttpServer();

  // One property per catalog code, so every code runs at least NUM_RUNS times.
  it.each(CODES)(
    'answers the catalog status and exact envelope for %s, without echoing request values',
    async (code) => {
      const send = TRIGGERS[code] ?? simulated(code);
      const expected = ERROR_CATALOG[code];

      await fc.assert(
        fc.asyncProperty(adversarial, async (value) => {
          const response = await send(server(), value);

          expect(response.status).toBe(expected.status);
          expect(response.body).toEqual({
            statusCode: expected.status,
            code,
            message: expected.message,
            details: expect.any(Array),
          });
          expect(Object.keys(response.body).sort()).toEqual([
            'code',
            'details',
            'message',
            'statusCode',
          ]);
          expect(response.body.details.every((detail: unknown) => typeof detail === 'string')).toBe(
            true,
          );
          expect(response.body.message).not.toContain(value);
          expect(response.text).not.toContain(value);
        }),
        { numRuns: NUM_RUNS },
      );
    },
  );
});
