import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import request from 'supertest';
import type { AppConfig } from '../../config/env.config';
import type { OriginSecretSource } from '../../config/origin-secret.provider';
import { TEST_ORIGIN_SECRET } from '../../../../test/support/http-pipeline-app';
import { createApp } from '../create-app';
import { JsonLogger } from '../logging/json-logger';

// HTTP properties run the real app with supertest. Each iteration builds a fresh app, so each one
// starts with an empty throttler storage.
const NUM_RUNS = 25;
const LIMIT = 60;
const MAX_REQUESTS_PER_IP = 75;
const MAX_IPS = 3;
const START_MS = 1_700_000_000_000;

const FEES = '/api/v1/fees';
const HEALTH = '/api/v1/health';
const ORIGIN_HEADER = 'X-Origin-Verify';
const VIEWER_ADDRESS_HEADER = 'CloudFront-Viewer-Address';

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

const originSecret: OriginSecretSource = {
  load: jest.fn(),
  get: () => ok(TEST_ORIGIN_SECRET),
};

const silentOutput = { write: (): boolean => true };

interface IpPlan {
  readonly ip: string;
  readonly feesRequests: number;
  readonly healthRequests: number;
}

type Operation = { readonly kind: 'fees' | 'health'; readonly ip: string };

// Each IP gets its own count of fees and health requests. The IPs are distinct, so every
// counter starts from zero.
const plans: fc.Arbitrary<IpPlan[]> = fc.uniqueArray(
  fc.record({
    ip: fc.ipV4(),
    feesRequests: fc.integer({ min: 1, max: MAX_REQUESTS_PER_IP }),
    healthRequests: fc.integer({ min: 0, max: MAX_REQUESTS_PER_IP }),
  }),
  { selector: (plan) => plan.ip, minLength: 1, maxLength: MAX_IPS },
);

// Interleaves each IP's fees and health requests, so health calls land between counted calls.
function operationsFor(plan: IpPlan): Operation[] {
  const operations: Operation[] = [];
  const longest = Math.max(plan.feesRequests, plan.healthRequests);
  for (let index = 0; index < longest; index += 1) {
    if (index < plan.healthRequests) operations.push({ kind: 'health', ip: plan.ip });
    if (index < plan.feesRequests) operations.push({ kind: 'fees', ip: plan.ip });
  }
  return operations;
}

async function sendOperation(server: Server, operation: Operation): Promise<request.Response> {
  const path = operation.kind === 'fees' ? FEES : HEALTH;
  return request(server)
    .get(path)
    .set(ORIGIN_HEADER, TEST_ORIGIN_SECRET)
    .set(VIEWER_ADDRESS_HEADER, `${operation.ip}:443`);
}

async function createTestApp(): Promise<INestApplication> {
  const app = await createApp({
    config,
    originSecret,
    logger: new JsonLogger({ stdout: silentOutput, stderr: silentOutput }),
  });
  // Listening once lets supertest reuse this server for every request in the iteration.
  await app.listen(0, '127.0.0.1');
  return app;
}

describe('Feature: payments-api, Property 40: the rate limiter enforces exactly 60 requests per 60 s per Client_IP, and never counts GET /health', () => {
  it('lets the first 60 fees requests per IP pass, answers 429 after that, ignores health calls, and keeps IPs independent', async () => {
    await fc.assert(
      fc.asyncProperty(plans, async (ipPlans) => {
        // The throttler's sliding window reads Date.now(). Freezing it keeps every request in one
        // 60 s window, regardless of how long the iteration takes.
        const clock = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
        const app = await createTestApp();
        try {
          const server = app.getHttpServer();
          for (const plan of ipPlans) {
            const feesStatuses: number[] = [];
            for (const operation of operationsFor(plan)) {
              const response = await sendOperation(server, operation);
              if (operation.kind === 'health') {
                expect(response.status).toBe(200);
                continue;
              }
              feesStatuses.push(response.status);
              if (response.status === 429) {
                expect(response.body.code).toBe('TOO_MANY_REQUESTS');
              }
            }
            const expected = Array.from({ length: plan.feesRequests }, (_, index) =>
              index < LIMIT ? 200 : 429,
            );
            expect(feesStatuses).toEqual(expected);
          }
        } finally {
          await app.close();
          clock.mockRestore();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30_000);
});
