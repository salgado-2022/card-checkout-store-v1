import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { INestApplication } from '@nestjs/common';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import * as https from 'node:https';
import request from 'supertest';
import type { AppConfig } from '../config/env.config';
import {
  createOriginSecretProvider,
  resetOriginSecretCacheForTests,
} from '../config/origin-secret.provider';
import { createApp } from './create-app';
import { JsonLogger } from './logging/json-logger';

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

const silentOutput = { write: (): boolean => true };

// Feature: platform-foundation, Property 3: Health endpoint responds without side-effecting calls
describe('Feature: platform-foundation, Property 3: health responds without side-effecting calls', () => {
  const ssm = mockClient(SSMClient);
  let app: INestApplication;
  let httpsConnectSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    resetOriginSecretCacheForTests();
    ssm.reset();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET } });
    const originSecret = createOriginSecretProvider(config, new SSMClient({}));
    const loaded = await originSecret.load();
    expect(loaded.isOk()).toBe(true);

    app = await createApp({
      config,
      originSecret,
      logger: new JsonLogger({ stdout: silentOutput, stderr: silentOutput }),
    });
    // Every outbound HTTPS connection (SSM, DynamoDB, payment gateway) opens through the HTTPS agent.
    httpsConnectSpy = jest.spyOn(https.Agent.prototype, 'createConnection');
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterAll(async () => {
    httpsConnectSpy.mockRestore();
    fetchSpy.mockRestore();
    await app.close();
    ssm.restore();
    resetOriginSecretCacheForTests();
  });

  it('returns 200 {"status":"ok"} and makes no SSM, outbound HTTPS connection or fetch call for any valid request', async () => {
    ssm.resetHistory();
    httpsConnectSpy.mockClear();
    fetchSpy.mockClear();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          requestId: fc.option(fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/), { nil: undefined }),
          query: fc.option(fc.stringMatching(/^[a-z]{1,8}=[a-z0-9]{0,8}$/), { nil: undefined }),
          acceptJson: fc.boolean(),
        }),
        async ({ requestId, query, acceptJson }) => {
          const url = query === undefined ? '/api/v1/health' : `/api/v1/health?${query}`;
          let call = request(app.getHttpServer()).get(url).set('X-Origin-Verify', SECRET);
          if (requestId !== undefined) {
            call = call.set('X-Request-Id', requestId);
          }
          if (acceptJson) {
            call = call.set('Accept', 'application/json');
          }

          const response = await call;

          expect(response.status).toBe(200);
          expect(response.body).toEqual({ status: 'ok' });
          expect(ssm.calls()).toHaveLength(0);
          expect(httpsConnectSpy).not.toHaveBeenCalled();
          expect(fetchSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('control: the HTTPS spy does observe an outbound connection attempt', async () => {
    httpsConnectSpy.mockClear();

    await new Promise<void>((resolve) => {
      const outbound = https.get('https://127.0.0.1:1/', () => resolve());
      outbound.on('error', () => resolve());
    });

    expect(httpsConnectSpy).toHaveBeenCalled();
    httpsConnectSpy.mockClear();
  });
});
