import type { INestApplication } from '@nestjs/common';
import { ok } from 'neverthrow';
import request from 'supertest';
import type { AppConfig } from '../../config/env.config';
import type { OriginSecretSource } from '../../config/origin-secret.provider';
import { createApp } from '../create-app';
import { JsonLogger } from '../logging/json-logger';

// Fake values only. The origin secret is sent as the X-Origin-Verify header in every test request.
const ORIGIN_VERIFY_VALUE = 'test-origin-verify';
const ORIGIN_HEADER = 'X-Origin-Verify';
const VIEWER_ADDRESS_HEADER = 'CloudFront-Viewer-Address';
const FEES = '/api/v1/fees';
const HEALTH = '/api/v1/health';
const WINDOW_MS = 60_000;
const LIMIT = 60;
const START_MS = 1_700_000_000_000;

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
  get: () => ok(ORIGIN_VERIFY_VALUE),
};

const silentOutput = { write: (): boolean => true };

describe('rate limiter (HTTP)', () => {
  let app: INestApplication;
  // The throttler's sliding window reads Date.now(), so the clock is driven through this value.
  let nowMs: number;

  beforeEach(async () => {
    nowMs = START_MS;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    app = await createApp({
      config,
      originSecret,
      logger: new JsonLogger({ stdout: silentOutput, stderr: silentOutput }),
    });
    // Listening once on the loopback port lets supertest reuse this server for every request.
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const server = () => app.getHttpServer();

  const getFrom = (path: string, ip: string) =>
    request(server())
      .get(path)
      .set(ORIGIN_HEADER, ORIGIN_VERIFY_VALUE)
      .set(VIEWER_ADDRESS_HEADER, `${ip}:443`);

  // Sends n sequential requests and returns their status codes.
  async function sendMany(path: string, ip: string, n: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < n; i += 1) {
      statuses.push((await getFrom(path, ip)).status);
    }
    return statuses;
  }

  it('answers 429 on the 61st request within 60 s from one Client_IP', async () => {
    const statuses = await sendMany(FEES, '203.0.113.10', LIMIT + 1);

    expect(statuses.slice(0, LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);
  });

  it('returns the standard error envelope with X-Request-Id on the 429 response', async () => {
    await sendMany(FEES, '203.0.113.11', LIMIT);
    const response = await getFrom(FEES, '203.0.113.11');

    expect(response.status).toBe(429);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.body).toEqual({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests.',
      details: [],
    });
  });

  it('gives a different Client_IP its own counter', async () => {
    await sendMany(FEES, '203.0.113.20', LIMIT + 1);

    const otherIp = await getFrom(FEES, '203.0.113.21');

    expect(otherIp.status).toBe(200);
  });

  it('ignores the port of the viewer address, so one IP shares a single counter', async () => {
    await sendMany(FEES, '203.0.113.30', LIMIT);

    const samePortDifferent = await request(server())
      .get(FEES)
      .set(ORIGIN_HEADER, ORIGIN_VERIFY_VALUE)
      .set(VIEWER_ADDRESS_HEADER, '203.0.113.30:55555');

    expect(samePortDifferent.status).toBe(429);
  });

  it('does not trust X-Forwarded-For, so a spoofed header cannot reset the counter', async () => {
    await sendMany(FEES, '203.0.113.40', LIMIT);

    const spoofed = await getFrom(FEES, '203.0.113.40').set('X-Forwarded-For', '198.51.100.99');

    expect(spoofed.status).toBe(429);
  });

  it('keeps the window at exactly 60 s: still 429 at 59.999 s, 200 at 60 s', async () => {
    await sendMany(FEES, '203.0.113.50', LIMIT);

    nowMs = START_MS + WINDOW_MS - 1;
    expect((await getFrom(FEES, '203.0.113.50')).status).toBe(429);

    nowMs = START_MS + WINDOW_MS;
    expect((await getFrom(FEES, '203.0.113.50')).status).toBe(200);
  });

  it('never counts or answers 429 for GET /api/v1/health', async () => {
    const healthStatuses = await sendMany(HEALTH, '203.0.113.60', 100);

    expect(healthStatuses.every((status) => status === 200)).toBe(true);
  });

  it('keeps the full fees budget after 100 health requests from the same IP', async () => {
    await sendMany(HEALTH, '203.0.113.61', 100);

    const feesStatuses = await sendMany(FEES, '203.0.113.61', LIMIT + 1);

    expect(feesStatuses.slice(0, LIMIT).every((status) => status === 200)).toBe(true);
    expect(feesStatuses[LIMIT]).toBe(429);
  });

  it('keeps trust proxy disabled so Express never derives the client address from headers', () => {
    const express = app.getHttpAdapter().getInstance() as { get(setting: string): unknown };

    expect(express.get('trust proxy')).toBeFalsy();
  });

  it('keeps the origin guard ahead of the limiter: 403 responses do not consume the budget', async () => {
    for (let i = 0; i < LIMIT + 5; i += 1) {
      const response = await request(server())
        .get(FEES)
        .set(VIEWER_ADDRESS_HEADER, '203.0.113.70:443');
      expect(response.status).toBe(403);
    }

    const statuses = await sendMany(FEES, '203.0.113.70', LIMIT);

    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('keeps the media-type guard ahead of the limiter: an exhausted IP still gets 415', async () => {
    await sendMany(FEES, '203.0.113.80', LIMIT + 1);

    const response = await request(server())
      .post('/api/v1/customers')
      .set(ORIGIN_HEADER, ORIGIN_VERIFY_VALUE)
      .set(VIEWER_ADDRESS_HEADER, '203.0.113.80:443')
      .set('Content-Type', 'text/plain')
      .send('not json');

    expect(response.status).toBe(415);
    expect(response.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});
