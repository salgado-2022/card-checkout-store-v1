import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { INestApplication } from '@nestjs/common';
import { mockClient } from 'aws-sdk-client-mock';
import { ok } from 'neverthrow';
import request from 'supertest';
import { capturingLogger } from '../../../test/support/http-pipeline-app';
import type { AppConfig } from '../config/env.config';
import { createApp } from './create-app';

const SECRET = 'fake-origin-secret-value-123';
const MARKER = 'SDKFAILexampleMarker0001';

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

describe('Feature: payments-api, Property 43: Unexpected adapter failures are translated, never leaked', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  let app: INestApplication;
  let logged: string[];

  beforeAll(async () => {
    const captured = capturingLogger();
    logged = captured.lines;
    app = await createApp({
      config,
      originSecret: { load: jest.fn(), get: () => ok(SECRET) },
      logger: captured.logger,
    });
  });

  afterAll(async () => {
    await app.close();
    ddb.restore();
  });

  beforeEach(() => {
    ddb.reset();
    logged.length = 0;
  });

  it('answers 500 INTERNAL_ERROR with the fixed message, and neither the SDK message nor a stack appears in the body or the log', async () => {
    const failure = new Error(`ProvisionedThroughputExceeded ${MARKER}`);
    ddb.on(ScanCommand).callsFake(() => Promise.reject(failure));

    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('X-Origin-Verify', SECRET);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
      details: [],
    });
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.text).not.toContain(MARKER);
    expect(response.text).not.toMatch(/\n\s+at\s/);

    const output = logged.join('');
    expect(output).toContain('"code":"INTERNAL_ERROR"');
    expect(output).not.toContain(MARKER);
    expect(output).not.toMatch(/\n\s+at\s/);
  });
});
