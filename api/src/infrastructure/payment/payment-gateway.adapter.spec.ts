import nock from 'nock';
import { PaymentGatewayAdapter } from './payment-gateway.adapter';

const BASE_URL = 'https://payment.test';
const PUBLIC_KEY = 'pub_test_fake';
const ACCEPTANCE_TOKEN = 'tok_test_fake_acceptance';
const PERSONAL_AUTH_TOKEN = 'tok_test_fake_personal';
const ACCEPTANCE_PERMALINK = 'https://payment.test/docs/acceptance';
const PERSONAL_AUTH_PERMALINK = 'https://payment.test/docs/personal-auth';
const MERCHANT_PATH = `/merchants/${PUBLIC_KEY}`;

const validBody = {
  data: {
    presigned_acceptance: {
      acceptance_token: ACCEPTANCE_TOKEN,
      permalink: ACCEPTANCE_PERMALINK,
      unrelated_field: 'ignored',
    },
    presigned_personal_data_auth: {
      acceptance_token: PERSONAL_AUTH_TOKEN,
      permalink: PERSONAL_AUTH_PERMALINK,
    },
  },
  extra: true,
};

const expectedTokens = {
  acceptanceToken: { token: ACCEPTANCE_TOKEN, permalink: ACCEPTANCE_PERMALINK },
  acceptPersonalAuth: { token: PERSONAL_AUTH_TOKEN, permalink: PERSONAL_AUTH_PERMALINK },
};

// Short timings keep the retry tests fast. The profile values are covered in provider-call-policy.spec.ts.
const FAST_TIMING = { attemptTimeoutMs: 200, backoffMs: 1 };

const SECRET_PARAMS = {
  paymentPrivateKeyParam: '/test/payment/private-key',
  paymentIntegritySecretParam: '/test/payment/integrity-secret',
};
const adapter = (publicKey = PUBLIC_KEY): PaymentGatewayAdapter =>
  new PaymentGatewayAdapter(
    { paymentApiUrl: BASE_URL, paymentPublicKey: publicKey, ...SECRET_PARAMS },
    FAST_TIMING,
  );

describe('PaymentGatewayAdapter.getAcceptanceTokens', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('maps the merchant response to acceptance tokens and permalinks', async () => {
    const scope = nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);

    const result = await adapter().getAcceptanceTokens();

    expect(result._unsafeUnwrap()).toEqual(expectedTokens);
    expect(scope.isDone()).toBe(true);
  });

  it('uses the Standard_Profile timing when no timing is injected', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);
    const defaultTimingAdapter = new PaymentGatewayAdapter({
      paymentApiUrl: BASE_URL,
      paymentPublicKey: PUBLIC_KEY,
      ...SECRET_PARAMS,
    });

    const result = await defaultTimingAdapter.getAcceptanceTokens();

    expect(result._unsafeUnwrap()).toEqual(expectedTokens);
  });

  it('sends a GET with no body and no credential beyond the public key in the path', async () => {
    let seen: { method?: string; headers: Record<string, unknown>; body: string } | undefined;
    nock(BASE_URL)
      .get(MERCHANT_PATH)
      .reply(function (_uri, requestBody) {
        seen = {
          method: this.req.method,
          headers: this.req.headers,
          body: String(requestBody),
        };
        return [200, validBody];
      });

    await adapter().getAcceptanceTokens();

    expect(seen?.method).toBe('GET');
    expect(seen?.body).toBe('');
    expect(seen?.headers['authorization']).toBeUndefined();
    expect(JSON.stringify(seen?.headers)).not.toContain('prv_');
  });

  it('encodes the public key segment and tolerates a trailing slash in the base URL', async () => {
    nock(BASE_URL).get('/merchants/pub_test%2Ffake').reply(200, validBody);
    const encodedAdapter = new PaymentGatewayAdapter(
      { paymentApiUrl: `${BASE_URL}//`, paymentPublicKey: 'pub_test/fake', ...SECRET_PARAMS },
      FAST_TIMING,
    );

    const result = await encodedAdapter.getAcceptanceTokens();

    expect(result.isOk()).toBe(true);
  });

  it('returns REJECTED without retrying on a 4xx', async () => {
    const scope = nock(BASE_URL).get(MERCHANT_PATH).reply(401, { error: 'denied' });

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({
      kind: 'REJECTED',
      providerMessage: 'HTTP 401',
      afterTransientFailure: false,
    });
    expect(scope.isDone()).toBe(true);
  });

  it('returns UNAVAILABLE after two 5xx answers and makes exactly two attempts', async () => {
    const scope = nock(BASE_URL).get(MERCHANT_PATH).times(2).reply(503, 'down');

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({ kind: 'UNAVAILABLE', reason: '503' });
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('succeeds when the retry after a 5xx answers 200', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(500, 'oops');
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);

    const result = await adapter().getAcceptanceTokens();

    expect(result._unsafeUnwrap()).toEqual(expectedTokens);
  });

  it('succeeds when the retry after a timeout answers 200', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).delay(1000).reply(200, validBody);
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);

    const result = await adapter().getAcceptanceTokens();

    expect(result._unsafeUnwrap()).toEqual(expectedTokens);
  });

  it('returns UNAVAILABLE with the AbortError reason when both attempts time out', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).times(2).delay(1000).reply(200, validBody);

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({ kind: 'UNAVAILABLE', reason: 'AbortError' });
  });

  it('returns REJECTED with afterTransientFailure when a 4xx follows a 5xx', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(502, 'bad gateway');
    nock(BASE_URL).get(MERCHANT_PATH).reply(404, 'missing');

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({
      kind: 'REJECTED',
      providerMessage: 'HTTP 404',
      afterTransientFailure: true,
    });
  });

  it('returns UNAVAILABLE with the exception name on a network failure, without retrying', async () => {
    const scope = nock(BASE_URL).get(MERCHANT_PATH).replyWithError('socket hang up');

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error.kind).toBe('UNAVAILABLE');
    expect(error).toEqual({ kind: 'UNAVAILABLE', reason: expect.any(String) });
    expect(error).not.toHaveProperty('message');
    expect(scope.isDone()).toBe(true);
  });

  it('returns INVALID_RESPONSE for a redirect, without following it', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(302, '', { Location: 'https://payment.test/other' });

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: '302' });
  });

  it('returns INVALID_RESPONSE when the body is not JSON', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, '<html>not json</html>');

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: 'SyntaxError' });
  });

  it('records the exception class when reading the body fails with an Error', async () => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);
    const readSpy = jest
      .spyOn(Response.prototype, 'json')
      .mockRejectedValueOnce(new TypeError('body stream broke'));

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    readSpy.mockRestore();
    expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: 'TypeError' });
  });

  it.each([
    ['a string', 'plain string'],
    ['an object without a name', { code: 'E_BROKEN' }],
  ])('records UnknownError when the body read rejects with %s', async (_label, rejection) => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);
    const readSpy = jest.spyOn(Response.prototype, 'json').mockRejectedValueOnce(rejection);

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    readSpy.mockRestore();
    expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: 'UnknownError' });
  });

  it.each([
    ['empty object', {}],
    [
      'missing presigned_personal_data_auth',
      { data: { presigned_acceptance: validBody.data.presigned_acceptance } },
    ],
    [
      'missing acceptance_token',
      {
        data: {
          presigned_acceptance: { permalink: ACCEPTANCE_PERMALINK },
          presigned_personal_data_auth: validBody.data.presigned_personal_data_auth,
        },
      },
    ],
    [
      'empty acceptance_token',
      {
        data: {
          presigned_acceptance: { acceptance_token: '', permalink: ACCEPTANCE_PERMALINK },
          presigned_personal_data_auth: validBody.data.presigned_personal_data_auth,
        },
      },
    ],
    [
      'non-https permalink',
      {
        data: {
          presigned_acceptance: {
            acceptance_token: ACCEPTANCE_TOKEN,
            permalink: 'javascript:alert(1)',
          },
          presigned_personal_data_auth: validBody.data.presigned_personal_data_auth,
        },
      },
    ],
    ['null body', 'null'],
  ])('returns INVALID_RESPONSE when the shape is wrong: %s', async (_label, body) => {
    nock(BASE_URL).get(MERCHANT_PATH).reply(200, body);

    const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

    expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: 'SchemaMismatch' });
  });

  describe('secrets and bodies stay out of errors and logs', () => {
    let logSpies: jest.SpyInstance[];

    beforeEach(() => {
      logSpies = [
        jest.spyOn(console, 'log').mockImplementation(() => undefined),
        jest.spyOn(console, 'info').mockImplementation(() => undefined),
        jest.spyOn(console, 'warn').mockImplementation(() => undefined),
        jest.spyOn(console, 'error').mockImplementation(() => undefined),
        jest.spyOn(process.stdout, 'write').mockImplementation(() => true),
        jest.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ];
    });

    afterEach(() => {
      logSpies.forEach((spy) => spy.mockRestore());
    });

    const sensitiveFragments = [PUBLIC_KEY, ACCEPTANCE_TOKEN, PERSONAL_AUTH_TOKEN, BASE_URL];

    const assertNoLeak = (value: unknown): void => {
      const serialized = JSON.stringify(value);
      for (const fragment of sensitiveFragments) {
        expect(serialized).not.toContain(fragment);
      }
    };

    it.each([
      [
        '4xx with a body echoing the token',
        () => nock(BASE_URL).get(MERCHANT_PATH).reply(400, { echo: ACCEPTANCE_TOKEN }),
      ],
      [
        '5xx with a body echoing the key',
        () => nock(BASE_URL).get(MERCHANT_PATH).times(2).reply(500, PUBLIC_KEY),
      ],
      [
        'malformed body echoing the token',
        () =>
          nock(BASE_URL)
            .get(MERCHANT_PATH)
            .reply(200, { data: { leaked: ACCEPTANCE_TOKEN } }),
      ],
      [
        'network failure',
        () => nock(BASE_URL).get(MERCHANT_PATH).replyWithError(`fail ${PUBLIC_KEY}`),
      ],
    ])(
      '%s: the error value and captured output hold no key, token or URL',
      async (_label, setup) => {
        setup();

        const error = (await adapter().getAcceptanceTokens())._unsafeUnwrapErr();

        assertNoLeak(error);
        for (const spy of logSpies) {
          for (const call of spy.mock.calls) {
            assertNoLeak(call);
          }
        }
      },
    );

    it('a successful call logs nothing and returns no secret in logs', async () => {
      nock(BASE_URL).get(MERCHANT_PATH).reply(200, validBody);

      const result = await adapter().getAcceptanceTokens();

      expect(result.isOk()).toBe(true);
      for (const spy of logSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });
});
