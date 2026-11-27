import type { INestApplication } from '@nestjs/common';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { err, errAsync, ok, okAsync, type ResultAsync } from 'neverthrow';
import type { AppConfig, ConfigError } from '../config/env.config';
import type { OriginSecretError, OriginSecretSource } from '../config/origin-secret.provider';
import { createApp } from '../http/create-app';
import {
  adaptNestApp,
  createInitCache,
  initServer,
  prepareApp,
  type BootstrapError,
  type InitServerDeps,
  type LambdaHandler,
} from './bootstrap';

const SECRET_VALUE = 'fake-origin-secret-value-123';
const CONFIG_VALUE = 'fake-config-value-456';

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

const secretError: OriginSecretError = {
  kind: 'ORIGIN_SECRET_UNAVAILABLE',
  parameterName: '/test/origin/verify-secret',
  reason: 'ParameterNotFound',
};

const sourceWith = (load: () => ResultAsync<string, OriginSecretError>): OriginSecretSource => ({
  load,
  get: () => ok(SECRET_VALUE),
});

const fakeApp = {} as INestApplication;
const fakeHandler: LambdaHandler = jest.fn().mockResolvedValue({ statusCode: 200 });

interface Mocks {
  deps: InitServerDeps;
  loadConfig: jest.Mock;
  load: jest.Mock;
  createApp: jest.Mock;
  adapt: jest.Mock;
}

const buildDeps = (overrides: Partial<InitServerDeps> = {}): Mocks => {
  const loadConfig = jest.fn(() => ok(config));
  const load = jest.fn(() => okAsync(SECRET_VALUE));
  const createAppMock = jest.fn().mockResolvedValue(fakeApp);
  const adapt = jest.fn(() => fakeHandler);
  const deps: InitServerDeps = {
    loadConfig,
    createSecretProvider: () => sourceWith(load),
    createApp: createAppMock,
    adapt,
    ...overrides,
  };
  return { deps, loadConfig, load, createApp: createAppMock, adapt };
};

describe('prepareApp', () => {
  it('loads config, then the secret, then creates the app with both', async () => {
    const order: string[] = [];
    const mocks = buildDeps({
      loadConfig: () => {
        order.push('config');
        return ok(config);
      },
      createSecretProvider: () =>
        sourceWith(() => {
          order.push('secret');
          return okAsync(SECRET_VALUE);
        }),
      createApp: jest.fn(async () => {
        order.push('app');
        return fakeApp;
      }),
    });

    const result = await prepareApp(mocks.deps);

    expect(result._unsafeUnwrap()).toBe(fakeApp);
    expect(order).toEqual(['config', 'secret', 'app']);
  });

  it('passes the loaded config and the secret source to createApp', async () => {
    const mocks = buildDeps();

    await prepareApp(mocks.deps);

    expect(mocks.createApp).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        originSecret: expect.objectContaining({ load: mocks.load }),
      }),
    );
  });

  it('fails with the variable name only when the config is invalid', async () => {
    const configError: ConfigError = { kind: 'INVALID_ENV_VAR', variableName: 'PAYMENT_API_URL' };
    const mocks = buildDeps({ loadConfig: () => err(configError) });

    const result = await prepareApp(mocks.deps);

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe('INVALID_CONFIG');
    expect(error.message).toContain('PAYMENT_API_URL');
    expect(error.message).not.toContain(CONFIG_VALUE);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('fails with the parameter name only when the secret cannot be loaded, without creating the app', async () => {
    const mocks = buildDeps();
    mocks.load.mockReturnValue(errAsync(secretError));

    const result = await prepareApp(mocks.deps);

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe('ORIGIN_SECRET_UNAVAILABLE');
    expect(error.message).toContain('/test/origin/verify-secret');
    expect(error.message).not.toContain(SECRET_VALUE);
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('reports the error class name only when app creation rejects', async () => {
    const mocks = buildDeps();
    mocks.createApp.mockRejectedValue(new TypeError(`bad value ${SECRET_VALUE}`));

    const error = (await prepareApp(mocks.deps))._unsafeUnwrapErr();

    expect(error.kind).toBe('APP_CREATION_FAILED');
    expect(error.message).toContain('TypeError');
    expect(error.message).not.toContain(SECRET_VALUE);
  });

  it('handles a non-Error rejection', async () => {
    const mocks = buildDeps();
    mocks.createApp.mockRejectedValue('boom');

    const error = (await prepareApp(mocks.deps))._unsafeUnwrapErr();

    expect(error.message).toContain('UnknownError');
  });
});

describe('initServer', () => {
  it('returns the adapted handler for the created app', async () => {
    const mocks = buildDeps();

    const result = await initServer(mocks.deps);

    expect(result._unsafeUnwrap()).toBe(fakeHandler);
    expect(mocks.adapt).toHaveBeenCalledWith(fakeApp);
  });

  it('propagates a config failure without touching the adapter', async () => {
    const mocks = buildDeps({
      loadConfig: () => err({ kind: 'MISSING_ENV_VAR', variableName: 'DYNAMODB_TABLE_PRODUCTS' }),
    });

    const error = (await initServer(mocks.deps))._unsafeUnwrapErr();

    expect(error.message).toBe('Invalid configuration: DYNAMODB_TABLE_PRODUCTS');
    expect(mocks.adapt).not.toHaveBeenCalled();
  });

  it('reports an adapter that throws as an app creation failure', async () => {
    const mocks = buildDeps({
      adapt: () => {
        throw new RangeError('no adapter');
      },
    });

    const error = (await initServer(mocks.deps))._unsafeUnwrapErr();

    expect(error.kind).toBe('APP_CREATION_FAILED');
    expect(error.message).toContain('RangeError');
  });
});

describe('createInitCache', () => {
  it('initializes once for many sequential and concurrent calls', async () => {
    const mocks = buildDeps();
    const getServer = createInitCache(() => initServer(mocks.deps));

    const first = await Promise.all(Array.from({ length: 20 }, () => getServer()));
    const later = await getServer();

    expect(first.every((result) => result.isOk())).toBe(true);
    expect(later._unsafeUnwrap()).toBe(fakeHandler);
    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.createApp).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure: the next call retries and can succeed', async () => {
    const mocks = buildDeps();
    mocks.load.mockReturnValueOnce(errAsync(secretError));
    const getServer = createInitCache(() => initServer(mocks.deps));

    const failed = await getServer();
    const recovered = await getServer();
    const cached = await getServer();

    expect(failed.isErr()).toBe(true);
    expect(recovered._unsafeUnwrap()).toBe(fakeHandler);
    expect(cached._unsafeUnwrap()).toBe(fakeHandler);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.createApp).toHaveBeenCalledTimes(1);
  });

  it('shares one failed attempt between concurrent callers, then retries', async () => {
    const mocks = buildDeps();
    mocks.loadConfig.mockReturnValue(
      err({ kind: 'MISSING_ENV_VAR', variableName: 'PAYMENT_API_URL' }),
    );
    const getServer = createInitCache(() => initServer(mocks.deps));

    const results = await Promise.all([getServer(), getServer(), getServer()]);
    await getServer();

    expect(results.every((result) => result.isErr())).toBe(true);
    expect(mocks.loadConfig).toHaveBeenCalledTimes(2);
  });

  it('drops the cached attempt when init itself rejects', async () => {
    const init = jest
      .fn<ResultAsync<string, BootstrapError>, []>()
      .mockImplementationOnce(() => {
        throw new Error('unexpected');
      })
      .mockReturnValue(okAsync('ready'));
    const getServer = createInitCache(init);

    await expect(getServer()).rejects.toThrow('unexpected');
    const retried = await getServer();

    expect(retried._unsafeUnwrap()).toBe('ready');
    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe('adaptNestApp', () => {
  const functionUrlEvent = (headers: Record<string, string>): APIGatewayProxyEventV2 => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/v1/health',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'url-id',
      domainName: 'url-id.lambda-url.us-east-1.on.aws',
      domainPrefix: 'url-id',
      http: {
        method: 'GET',
        path: '/api/v1/health',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.10',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 1767225600000,
    },
    isBase64Encoded: false,
  });

  const context = {} as Context;

  it('serves a Function URL (payload v2) event through the real Nest app', async () => {
    const app = await createApp({ config, originSecret: sourceWith(() => okAsync(SECRET_VALUE)) });
    try {
      const handler = adaptNestApp(app);

      const ok200 = await handler(functionUrlEvent({ 'x-origin-verify': SECRET_VALUE }), context);
      const forbidden = await handler(functionUrlEvent({}), context);

      expect(ok200.statusCode).toBe(200);
      expect(ok200.body).toBe(JSON.stringify({ status: 'ok' }));
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
