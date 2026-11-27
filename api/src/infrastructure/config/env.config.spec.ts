import { loadConfig } from './env.config';

const validEnv = (): Record<string, string> => ({
  PAYMENT_API_URL: 'https://payment.test.example/v1',
  PAYMENT_PUBLIC_KEY: 'pub_test_fake',
  PAYMENT_PRIVATE_KEY_PARAM: '/card-checkout/test/payment-private-key',
  PAYMENT_INTEGRITY_SECRET_PARAM: '/card-checkout/test/payment-integrity-secret',
  PAYMENT_EVENTS_SECRET_PARAM: '/card-checkout/test/payment-events-secret',
  ORIGIN_VERIFY_SECRET_PARAM: '/card-checkout/test/origin-verify-secret',
  DYNAMODB_TABLE_PRODUCTS: 'test-products',
  DYNAMODB_TABLE_CUSTOMERS: 'test-customers',
  DYNAMODB_TABLE_TRANSACTIONS: 'test-transactions',
  DYNAMODB_TABLE_DELIVERIES: 'test-deliveries',
  DYNAMODB_TABLE_IDEMPOTENCY_KEYS: 'test-idempotency-keys',
});

const REQUIRED_VARIABLES = [
  'PAYMENT_API_URL',
  'PAYMENT_PUBLIC_KEY',
  'PAYMENT_PRIVATE_KEY_PARAM',
  'PAYMENT_INTEGRITY_SECRET_PARAM',
  'PAYMENT_EVENTS_SECRET_PARAM',
  'ORIGIN_VERIFY_SECRET_PARAM',
  'DYNAMODB_TABLE_PRODUCTS',
  'DYNAMODB_TABLE_CUSTOMERS',
  'DYNAMODB_TABLE_TRANSACTIONS',
  'DYNAMODB_TABLE_DELIVERIES',
  'DYNAMODB_TABLE_IDEMPOTENCY_KEYS',
] as const;

const PARAM_VARIABLES = [
  'PAYMENT_PRIVATE_KEY_PARAM',
  'PAYMENT_INTEGRITY_SECRET_PARAM',
  'PAYMENT_EVENTS_SECRET_PARAM',
  'ORIGIN_VERIFY_SECRET_PARAM',
] as const;
describe('loadConfig', () => {
  it('returns the validated config when every variable is valid', () => {
    const result = loadConfig({
      ...validEnv(),
      BASE_FEE_IN_CENTS: '120000',
      DELIVERY_FEE_IN_CENTS: '50000',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      paymentApiUrl: 'https://payment.test.example/v1',
      paymentPublicKey: 'pub_test_fake',
      paymentPrivateKeyParam: '/card-checkout/test/payment-private-key',
      paymentIntegritySecretParam: '/card-checkout/test/payment-integrity-secret',
      paymentEventsSecretParam: '/card-checkout/test/payment-events-secret',
      originVerifySecretParam: '/card-checkout/test/origin-verify-secret',
      baseFeeInCents: 120000,
      deliveryFeeInCents: 50000,
      tables: {
        products: 'test-products',
        customers: 'test-customers',
        transactions: 'test-transactions',
        deliveries: 'test-deliveries',
        idempotencyKeys: 'test-idempotency-keys',
      },
    });
  });

  it.each(REQUIRED_VARIABLES)(
    'returns MISSING_ENV_VAR naming %s when it is not set',
    (variableName) => {
      const env = validEnv();
      delete env[variableName];

      const result = loadConfig(env);

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'MISSING_ENV_VAR', variableName });
    },
  );

  it.each(REQUIRED_VARIABLES)(
    'returns MISSING_ENV_VAR naming %s when it is blank',
    (variableName) => {
      const result = loadConfig({ ...validEnv(), [variableName]: '   ' });

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'MISSING_ENV_VAR', variableName });
    },
  );

  it('uses the default fees when the fee variables are not set', () => {
    const config = loadConfig(validEnv())._unsafeUnwrap();

    expect(config.baseFeeInCents).toBe(300000);
    expect(config.deliveryFeeInCents).toBe(800000);
  });

  it('uses the default fees when the fee variables are blank', () => {
    const config = loadConfig({
      ...validEnv(),
      BASE_FEE_IN_CENTS: '',
      DELIVERY_FEE_IN_CENTS: ' ',
    })._unsafeUnwrap();

    expect(config.baseFeeInCents).toBe(300000);
    expect(config.deliveryFeeInCents).toBe(800000);
  });

  it('uses explicit fee values instead of the defaults', () => {
    const config = loadConfig({
      ...validEnv(),
      BASE_FEE_IN_CENTS: '0',
      DELIVERY_FEE_IN_CENTS: '999',
    })._unsafeUnwrap();

    expect(config.baseFeeInCents).toBe(0);
    expect(config.deliveryFeeInCents).toBe(999);
  });

  it.each(['abc', '12.5', '-100', '1e6', '9007199254740993'])(
    'returns INVALID_ENV_VAR for BASE_FEE_IN_CENTS when it is %s',
    (value) => {
      const result = loadConfig({ ...validEnv(), BASE_FEE_IN_CENTS: value });

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_ENV_VAR',
        variableName: 'BASE_FEE_IN_CENTS',
      });
    },
  );

  it('returns INVALID_ENV_VAR for DELIVERY_FEE_IN_CENTS when it is not numeric', () => {
    const result = loadConfig({ ...validEnv(), DELIVERY_FEE_IN_CENTS: 'eight thousand' });

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'INVALID_ENV_VAR',
      variableName: 'DELIVERY_FEE_IN_CENTS',
    });
  });

  it('returns INVALID_ENV_VAR when the payment API URL is not a valid URL', () => {
    const result = loadConfig({ ...validEnv(), PAYMENT_API_URL: 'not-a-url' });

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'INVALID_ENV_VAR',
      variableName: 'PAYMENT_API_URL',
    });
  });

  it.each([
    'http://payment.test.example/v1',
    'ftp://payment.test.example/v1',
    'HTTP://payment.test.example/v1',
  ])('returns INVALID_ENV_VAR when the payment API URL is %s (not https)', (value) => {
    const result = loadConfig({ ...validEnv(), PAYMENT_API_URL: value });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'INVALID_ENV_VAR',
      variableName: 'PAYMENT_API_URL',
    });
  });
  it('accepts an https payment API URL', () => {
    const result = loadConfig({ ...validEnv(), PAYMENT_API_URL: 'https://payment.test.example' });
    expect(result.isOk()).toBe(true);
  });
  it.each(['prv_test_fake', 'test_fake', 'PUB_test_fake', ' pub_test_fake', 'pub_', 'pub_a b'])(
    'returns INVALID_ENV_VAR when PAYMENT_PUBLIC_KEY is %j',
    (value) => {
      const result = loadConfig({ ...validEnv(), PAYMENT_PUBLIC_KEY: value });
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_ENV_VAR',
        variableName: 'PAYMENT_PUBLIC_KEY',
      });
    },
  );
  it.each(PARAM_VARIABLES)('accepts a valid SSM parameter path for %s', (variableName) => {
    const result = loadConfig({ ...validEnv(), [variableName]: '/App_1/prod.env/some-key' });
    expect(result.isOk()).toBe(true);
  });
  it.each(PARAM_VARIABLES)('rejects malformed SSM parameter names for %s', (variableName) => {
    for (const value of [
      'no-leading-slash',
      '/',
      '/with space',
      '/with\nnewline',
      '/semi;colon',
      '/emoji-\u{1F600}',
      '/trailing$',
      'prv_test_fake_value',
    ]) {
      const result = loadConfig({ ...validEnv(), [variableName]: value });
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_ENV_VAR', variableName });
    }
  });
  it('never includes the offending value in the error', () => {
    const secretLikeValue = 'prv_test_fake_value_do_not_log';
    const result = loadConfig({ ...validEnv(), BASE_FEE_IN_CENTS: secretLikeValue });

    const error = result._unsafeUnwrapErr();
    expect(Object.keys(error).sort()).toEqual(['kind', 'variableName']);
    expect(JSON.stringify(error)).not.toContain(secretLikeValue);
  });

  it('reads process.env when no environment object is passed', () => {
    const originalEnv = process.env;
    process.env = { ...validEnv(), BASE_FEE_IN_CENTS: '4321' };
    try {
      const config = loadConfig()._unsafeUnwrap();

      expect(config.baseFeeInCents).toBe(4321);
      expect(config.deliveryFeeInCents).toBe(800000);
    } finally {
      process.env = originalEnv;
    }
  });
});
