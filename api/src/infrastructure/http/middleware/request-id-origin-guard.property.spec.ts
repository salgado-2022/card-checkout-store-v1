import { GetCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { INestApplication } from '@nestjs/common';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import request from 'supertest';
import type { AppConfig } from '../../config/env.config';
import type { OriginSecretSource } from '../../config/origin-secret.provider';
import { createApp } from '../create-app';
import { capturingLogger } from '../../../../test/support/http-pipeline-app';
import { ORIGIN_VERIFY_HEADER } from './origin-guard.middleware';
import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN } from './request-id.middleware';

const NUM_RUNS = 25;
const SECRET = 'fake-origin-secret-value-123';

const config: AppConfig = {
  paymentApiUrl: 'https://payment.example.test/v1',
  paymentPublicKey: 'pub_test_fake',
  paymentPrivateKeyParam: '/test/payment/private',
  paymentIntegritySecretParam: '/test/payment/integrity',
  paymentEventsSecretParam: '/test/payment/events',
  originVerifySecretParam: '/test/origin/verify-secret',
  baseFeeInCents: 300000,
  deliveryFeeInCents: 800000,
  tables: {
    products: 'products',
    customers: 'customers',
    transactions: 'transactions',
    deliveries: 'deliveries',
    idempotencyKeys: 'idempotency-keys',
  },
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options'] as const;
const PATH_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~'.split(
  '',
);
const pathSegment = fc
  .array(fc.constantFrom(...PATH_CHARACTERS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(''));
const randomPath = fc
  .array(pathSegment, { minLength: 0, maxLength: 4 })
  .map((segments) => `/${segments.join('/')}`);
// Business routes, the health route, the root and unknown paths, both inside and outside the prefix.
const knownPath = fc.constantFrom(
  '/',
  '/api/v1/health',
  '/api/v1/products',
  '/api/v1/products/prod-1',
  '/api/v1/fees',
  '/api/v1/transactions/tx-1',
  '/api/v1/unknown',
  '/unknown',
);
const requestPath = fc.oneof(knownPath, randomPath);

// Visible ASCII only: Node trims spaces at the edges of a header value.
const visibleAscii = fc
  .array(
    fc.integer({ min: 0x21, max: 0x7e }).map((code) => String.fromCharCode(code)),
    {
      minLength: 1,
      maxLength: 40,
    },
  )
  .map((chars) => chars.join(''));

// Origin header: absent, empty, the secret, a near miss or random text.
const originHeader = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constant(''),
  fc.constant<string | undefined>(SECRET),
  fc.constantFrom(SECRET.toUpperCase(), SECRET.slice(0, -1), `${SECRET}x`),
  visibleAscii.filter((value) => value !== SECRET),
);

// Request id header: absent, a valid id, or one that must be replaced.
const requestIdHeader = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constantFrom('req-abcdef12', 'trace.id_0001', 'a'.repeat(64)),
  fc.stringMatching(/^[A-Za-z0-9._-]{8,64}$/),
  fc.constantFrom('short', 'has space in it', 'x'.repeat(65), 'bad/slash/value'),
);

describe('Feature: payments-api, Property 38: Every response carries a request id, and the origin guard is absolute', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  let app: INestApplication;

  beforeAll(async () => {
    ddb.on(ScanCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({});
    const originSecret: OriginSecretSource = {
      load: jest.fn(),
      get: () => ok(SECRET),
    };
    app = await createApp({
      config,
      originSecret,
      logger: capturingLogger().logger,
    });
  });

  afterAll(async () => {
    await app.close();
    ddb.restore();
  });

  it('sends a well-formed X-Request-Id on every response, and rejects every request without a valid origin with 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...METHODS),
        requestPath,
        originHeader,
        requestIdHeader,
        async (method, path, origin, incomingId) => {
          let call = request(app.getHttpServer())[method](path);
          if (origin !== undefined) {
            call = call.set(ORIGIN_VERIFY_HEADER, origin);
          }
          if (incomingId !== undefined) {
            call = call.set(REQUEST_ID_HEADER, incomingId);
          }
          const response = await call;

          const requestId = response.headers[REQUEST_ID_HEADER];
          expect(requestId).toEqual(expect.any(String));
          expect(requestId).toMatch(REQUEST_ID_PATTERN);
          if (incomingId !== undefined && REQUEST_ID_PATTERN.test(incomingId)) {
            expect(requestId).toBe(incomingId);
          }

          if (origin === SECRET) {
            expect(response.status).not.toBe(403);
          } else {
            expect(response.status).toBe(403);
            expect(response.body).toEqual({
              statusCode: 403,
              code: 'FORBIDDEN_ORIGIN',
              message: 'Origin not allowed.',
              details: [],
            });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
