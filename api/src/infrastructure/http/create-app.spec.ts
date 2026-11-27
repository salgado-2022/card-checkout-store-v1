import type { INestApplication } from '@nestjs/common';
import { err, ok } from 'neverthrow';
import request from 'supertest';
import type { AppConfig } from '../config/env.config';
import type { OriginSecretError, OriginSecretSource } from '../config/origin-secret.provider';
import { createApp } from './create-app';
import { JsonLogger } from './logging/json-logger';

const SECRET = 'fake-origin-secret-value-123';
const HEALTH = '/api/v1/health';

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

const stubSource = (value: string): OriginSecretSource => ({
  load: jest.fn(),
  get: () => ok(value),
});

const silentLogger = (): { logger: JsonLogger; lines: string[] } => {
  const lines: string[] = [];
  const output = {
    write: (chunk: string): boolean => {
      lines.push(chunk);
      return true;
    },
  };
  return { logger: new JsonLogger({ stdout: output, stderr: output }), lines };
};

describe('createApp', () => {
  let app: INestApplication;
  let lines: string[];

  beforeAll(async () => {
    const silent = silentLogger();
    lines = silent.lines;
    app = await createApp({ config, originSecret: stubSource(SECRET), logger: silent.logger });
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it('answers 200 with {"status":"ok"} when the origin header is valid', async () => {
    const response = await request(server()).get(HEALTH).set('X-Origin-Verify', SECRET);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('answers 403 with the fixed envelope when the origin header is missing', async () => {
    const response = await request(server()).get(HEALTH);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: 'FORBIDDEN_ORIGIN',
      message: 'Origin not allowed.',
      details: [],
    });
  });

  it('answers 403 when the origin header is wrong, without echoing either value', async () => {
    const response = await request(server()).get(HEALTH).set('X-Origin-Verify', 'wrong-value');

    expect(response.status).toBe(403);
    expect(response.text).not.toContain(SECRET);
    expect(response.text).not.toContain('wrong-value');
  });

  it('answers a JSON 404 envelope on an unknown route under the prefix with a valid header', async () => {
    const response = await request(server()).get('/api/v1/unknown').set('X-Origin-Verify', SECRET);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', details: [] });
    expect(typeof response.body.message).toBe('string');
  });

  it('answers 403 on unknown and webhook-like routes under the prefix without the header', async () => {
    const unknown = await request(server()).get('/api/v1/unknown');
    const nested = await request(server()).post('/api/v1/webhooks/payments').send({});

    expect(unknown.status).toBe(403);
    expect(nested.status).toBe(403);
    expect(nested.body.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('answers 403 on an unknown route outside the global prefix without the header', async () => {
    const response = await request(server()).get('/unknown');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: 'FORBIDDEN_ORIGIN',
      message: 'Origin not allowed.',
      details: [],
    });
  });

  it('answers a JSON 404 on an unknown route outside the prefix with a valid header', async () => {
    const response = await request(server()).get('/unknown').set('X-Origin-Verify', SECRET);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', details: [] });
  });

  it('answers 403 on the root path without the header', async () => {
    const response = await request(server()).get('/');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('logs exactly one line per request, including routes under the prefix', async () => {
    lines.length = 0;
    await request(server()).get(HEALTH).set('X-Origin-Verify', SECRET);
    await request(server()).get('/unknown').set('X-Origin-Verify', SECRET);
    await new Promise((resolve) => setImmediate(resolve));

    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.message === 'request completed');
    expect(completed.map((entry) => entry.path)).toEqual([HEALTH, '/unknown']);
  });

  it('echoes an incoming X-Request-Id on routes outside the prefix', async () => {
    const response = await request(server())
      .get('/unknown')
      .set('X-Origin-Verify', SECRET)
      .set('X-Request-Id', 'req-outside-prefix');

    expect(response.headers['x-request-id']).toBe('req-outside-prefix');
  });

  it('replaces an invalid incoming X-Request-Id with a generated one', async () => {
    const response = await request(server())
      .get(HEALTH)
      .set('X-Origin-Verify', SECRET)
      .set('X-Request-Id', 'bad id with spaces');

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('does not serve health outside the global prefix', async () => {
    const response = await request(server()).get('/health').set('X-Origin-Verify', SECRET);

    expect(response.status).toBe(404);
  });

  it('sets X-Request-Id on 200, 403 and 404 responses', async () => {
    const ok200 = await request(server()).get(HEALTH).set('X-Origin-Verify', SECRET);
    const denied = await request(server()).get(HEALTH);
    const notFound = await request(server()).get('/api/v1/unknown').set('X-Origin-Verify', SECRET);

    for (const response of [ok200, denied, notFound]) {
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
      expect(response.headers['x-request-id']).not.toBe('');
    }
  });

  it('echoes an incoming X-Request-Id', async () => {
    const response = await request(server())
      .get(HEALTH)
      .set('X-Origin-Verify', SECRET)
      .set('X-Request-Id', 'req-from-client');

    expect(response.headers['x-request-id']).toBe('req-from-client');
  });

  it('does not advertise the framework through X-Powered-By', async () => {
    const response = await request(server()).get(HEALTH).set('X-Origin-Verify', SECRET);

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('runs the request logger after the request id, so log lines carry the request id', async () => {
    lines.length = 0;

    await request(server())
      .get(HEALTH)
      .set('X-Origin-Verify', SECRET)
      .set('X-Request-Id', 'req-order-check');
    await new Promise((resolve) => setImmediate(resolve));

    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.message === 'request completed');
    expect(completed).toMatchObject({
      requestId: 'req-order-check',
      method: 'GET',
      path: HEALTH,
      statusCode: 200,
    });
  });

  it('fails closed with 403 when the origin secret was never loaded', async () => {
    const silent = silentLogger();
    const notLoaded: OriginSecretError = {
      kind: 'ORIGIN_SECRET_NOT_LOADED',
      parameterName: config.originVerifySecretParam,
      reason: 'load() has not completed',
    };
    const failing = await createApp({
      config,
      originSecret: { load: jest.fn(), get: () => err(notLoaded) },
      logger: silent.logger,
    });

    try {
      const response = await request(failing.getHttpServer())
        .get(HEALTH)
        .set('X-Origin-Verify', SECRET);

      expect(response.status).toBe(403);
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
    } finally {
      await failing.close();
    }
  });

  it('creates an app with the default logger when none is given', async () => {
    const defaultApp = await createApp({ config, originSecret: stubSource(SECRET) });

    try {
      expect(defaultApp.getHttpServer()).toBeDefined();
    } finally {
      await defaultApp.close();
    }
  });
});
