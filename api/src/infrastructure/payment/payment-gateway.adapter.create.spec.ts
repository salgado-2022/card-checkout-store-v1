import { createHash } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import nock from 'nock';
import type { PaymentCreateRequest } from '../../application/ports/payment-gateway';
import { resetSsmParameterCacheForTests, SsmParameterReader } from '../config/ssm-parameter-reader';
import { PaymentGatewayAdapter, rejectionMessageFrom } from './payment-gateway.adapter';
import { STANDARD_PROFILE_TIMING } from './provider-call-policy';

const BASE_URL = 'https://payment.test';
const CREATE_PATH = '/transactions';
const PRIVATE_PARAM = '/test/payment/private-key';
const INTEGRITY_PARAM = '/test/payment/integrity-secret';
const PRIVATE_VALUE = 'prv_test_fake';
const INTEGRITY_VALUE = 'integrity_test_fake';
const CARD_VALUE = 'tok_test_fake';
const ACCEPTANCE_VALUE = 'tok_test_fake_acceptance';
const PERSONAL_AUTH_VALUE = 'tok_test_fake_personal';

const request: PaymentCreateRequest = {
  reference: 'ORD-TEST-0001',
  amountInCents: 25_100_000,
  currency: 'COP',
  customerEmail: 'buyer@example.test',
  acceptanceToken: ACCEPTANCE_VALUE,
  acceptPersonalAuth: PERSONAL_AUTH_VALUE,
  cardToken: CARD_VALUE,
  installments: 3,
};

// Computed here from the fake inputs, independently of the adapter's helper.
const expectedHex = createHash('sha256')
  .update(`ORD-TEST-000125100000COP${INTEGRITY_VALUE}`, 'utf8')
  .digest('hex');

const created = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  data: {
    id: 'ext-test-001',
    status: 'PENDING',
    status_message: null,
    reference: request.reference,
    amount_in_cents: request.amountInCents,
    currency: 'COP',
    unrelated_field: 'ignored',
    ...overrides,
  },
  meta: {},
});

const FAST_TIMING = { attemptTimeoutMs: 200, backoffMs: 1 };
const config = {
  paymentApiUrl: BASE_URL,
  paymentPublicKey: 'pub_test_fake',
  paymentPrivateKeyParam: PRIVATE_PARAM,
  paymentIntegritySecretParam: INTEGRITY_PARAM,
};
const build = (timing = FAST_TIMING): PaymentGatewayAdapter =>
  new PaymentGatewayAdapter(config, timing, new SsmParameterReader());

describe('PaymentGatewayAdapter.create', () => {
  const ssm = mockClient(SSMClient);

  beforeEach(() => {
    nock.cleanAll();
    resetSsmParameterCacheForTests();
    ssm.reset();
    ssm.on(GetParameterCommand, { Name: PRIVATE_PARAM }).resolves({
      Parameter: { Value: PRIVATE_VALUE },
    });
    ssm.on(GetParameterCommand, { Name: INTEGRITY_PARAM }).resolves({
      Parameter: { Value: INTEGRITY_VALUE },
    });
  });

  afterAll(() => {
    ssm.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('request', () => {
    it('posts the exact body, the signature and the Bearer private key', async () => {
      let seen: { method: string; headers: Record<string, unknown>; body: unknown } | undefined;
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(201, function (_uri, requestBody) {
          seen = { method: this.req.method, headers: this.req.headers, body: requestBody };
          return created();
        });
      const result = await build().create(request);
      expect(result.isOk()).toBe(true);
      expect(seen?.method).toBe('POST');
      expect(seen?.headers['authorization']).toBe(`Bearer ${PRIVATE_VALUE}`);
      expect(seen?.headers['content-type']).toBe('application/json');
      expect(seen?.body).toEqual({
        amount_in_cents: 25_100_000,
        currency: 'COP',
        customer_email: 'buyer@example.test',
        reference: 'ORD-TEST-0001',
        acceptance_token: ACCEPTANCE_VALUE,
        accept_personal_auth: PERSONAL_AUTH_VALUE,
        payment_method: { type: 'CARD', token: CARD_VALUE, installments: 3 },
        signature: expectedHex,
      });
    });

    it('reads the private key and the integrity secret from the configured SSM parameters', async () => {
      nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      await build().create(request);
      const names = ssm.commandCalls(GetParameterCommand).map((call) => call.args[0].input.Name);
      expect([...names].sort()).toEqual([INTEGRITY_PARAM, PRIVATE_PARAM].sort());
    });

    it('tolerates a trailing slash in the base URL', async () => {
      nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      const adapter = new PaymentGatewayAdapter(
        { ...config, paymentApiUrl: `${BASE_URL}//` },
        FAST_TIMING,
        new SsmParameterReader(),
      );
      expect((await adapter.create(request)).isOk()).toBe(true);
    });

    it('uses the Standard_Profile timing and the SSM reader by default', async () => {
      nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      const result = await new PaymentGatewayAdapter(config).create(request);
      expect(result.isOk()).toBe(true);
    });

    it('is the only method that sends a creation request', async () => {
      const creation = nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      nock(BASE_URL)
        .get('/merchants/pub_test_fake')
        .reply(200, {
          data: {
            presigned_acceptance: { acceptance_token: 'a', permalink: 'https://payment.test/a' },
            presigned_personal_data_auth: {
              acceptance_token: 'b',
              permalink: 'https://payment.test/b',
            },
          },
        });
      const adapter = build();
      expect((await adapter.getAcceptanceTokens()).isOk()).toBe(true);
      expect(creation.isDone()).toBe(false);
    });
  });

  describe('success', () => {
    it('maps a PENDING response', async () => {
      nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      const result = await build().create(request);
      expect(result._unsafeUnwrap()).toEqual({
        externalId: 'ext-test-001',
        status: 'PENDING',
        message: null,
        amountInCents: 25_100_000,
        currency: 'COP',
        reference: 'ORD-TEST-0001',
      });
    });

    it('maps a final status and its message', async () => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(201, created({ status: 'DECLINED', status_message: 'Card declined' }));
      const value = (await build().create(request))._unsafeUnwrap();
      expect(value.status).toBe('DECLINED');
      expect(value.message).toBe('Card declined');
    });

    it('treats an absent status_message as null', async () => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(201, created({ status_message: undefined }));
      expect((await build().create(request))._unsafeUnwrap().message).toBeNull();
    });

    it('returns the provider-reported amount, currency and reference unchanged', async () => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(201, created({ amount_in_cents: 1, currency: 'USD', reference: 'ORD-OTHER' }));
      const value = (await build().create(request))._unsafeUnwrap();
      expect([value.amountInCents, value.currency, value.reference]).toEqual([
        1,
        'USD',
        'ORD-OTHER',
      ]);
    });

    it('succeeds when the retry after a 5xx answers 201', async () => {
      const scope = nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(503, 'unavailable')
        .post(CREATE_PATH)
        .reply(201, created());
      expect((await build().create(request)).isOk()).toBe(true);
      expect(scope.isDone()).toBe(true);
    });

    it('succeeds when the retry after a timeout answers 201', async () => {
      const scope = nock(BASE_URL)
        .post(CREATE_PATH)
        .delayConnection(1_000)
        .reply(201, created())
        .post(CREATE_PATH)
        .reply(201, created());
      expect((await build().create(request)).isOk()).toBe(true);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('4xx', () => {
    it('returns REJECTED with the error type and a single attempt', async () => {
      let served = 0;
      nock(BASE_URL)
        .post(CREATE_PATH)
        .times(2)
        .reply(422, () => {
          served += 1;
          return { error: { type: 'INPUT_VALIDATION_ERROR', messages: { reference: ['taken'] } } };
        });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'INPUT_VALIDATION_ERROR',
        afterTransientFailure: false,
      });
      expect(served).toBe(1);
    });

    it('treats an expired acceptance token like any other 4xx', async () => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(422, {
          error: {
            type: 'INPUT_VALIDATION_ERROR',
            messages: { acceptance_token: [`expired jwt ${ACCEPTANCE_VALUE}`] },
          },
        });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'INPUT_VALIDATION_ERROR',
        afterTransientFailure: false,
      });
    });

    it('flags afterTransientFailure when a 4xx answers the retry after a 5xx', async () => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(500, 'boom')
        .post(CREATE_PATH)
        .reply(422, { error: { type: 'INPUT_VALIDATION_ERROR' } });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'INPUT_VALIDATION_ERROR',
        afterTransientFailure: true,
      });
    });

    it('flags afterTransientFailure when a 4xx answers the retry after a timeout', async () => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .delayConnection(1_000)
        .reply(201, created())
        .post(CREATE_PATH)
        .reply(401, { error: { type: 'INVALID_ACCESS_TOKEN' } });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'INVALID_ACCESS_TOKEN',
        afterTransientFailure: true,
      });
    });

    it.each([
      ['a body that is not JSON', 'free text from the provider'],
      ['an empty body', ''],
      ['JSON without an error field', { message: 'free text' }],
      ['an error without a type', { error: { messages: { a: ['b'] } } }],
      ['a non-string type', { error: { type: 42 } }],
      ['a lower-case type', { error: { type: 'input_validation_error' } }],
      ['a type with spaces', { error: { type: 'FREE TEXT' } }],
      ['a type longer than 64 characters', { error: { type: 'A'.repeat(65) } }],
      ['an empty type', { error: { type: '' } }],
      ['a JSON array', [1, 2]],
      ['JSON null', null],
    ])('falls back to PROVIDER_REJECTED for %s', async (_label, body) => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(400, body as nock.Body);
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'PROVIDER_REJECTED',
        afterTransientFailure: false,
      });
    });

    it('accepts a type of exactly 64 characters', async () => {
      const type = 'A'.repeat(64);
      nock(BASE_URL).post(CREATE_PATH).reply(400, { error: { type } });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toMatchObject({ providerMessage: type });
    });

    it('falls back when the buffered body text exceeds the size limit', () => {
      expect(rejectionMessageFrom(' '.repeat(256 * 1024 + 1))).toBe('PROVIDER_REJECTED');
    });
  });

  describe('timeout, 5xx and invalid answers', () => {
    it('returns UNAVAILABLE after two 5xx answers and sends exactly two requests', async () => {
      let served = 0;
      nock(BASE_URL)
        .post(CREATE_PATH)
        .times(3)
        .reply(502, () => {
          served += 1;
          return 'bad gateway';
        });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: '502' });
      expect(served).toBe(2);
    });

    it('returns UNAVAILABLE after two timeouts and sends exactly two requests', async () => {
      let served = 0;
      nock(BASE_URL)
        .post(CREATE_PATH)
        .times(3)
        .delayConnection(1_000)
        .reply(201, () => {
          served += 1;
          return created();
        });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: 'AbortError' });
      expect(served).toBeLessThanOrEqual(2);
    });

    it('returns UNAVAILABLE without retrying on a network failure', async () => {
      nock(BASE_URL).post(CREATE_PATH).replyWithError('connection reset');
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error.kind).toBe('UNAVAILABLE');
    });

    it.each([
      ['a body that is not JSON', 'not json'],
      ['no data object', { meta: {} }],
      ['a missing id', created({ id: undefined })],
      ['an empty id', created({ id: '' })],
      ['an unknown status', created({ status: 'WEIRD' })],
      ['a fractional amount', created({ amount_in_cents: 10.5 })],
      ['a negative amount', created({ amount_in_cents: -1 })],
      ['a string amount', created({ amount_in_cents: '100' })],
      ['a missing currency', created({ currency: undefined })],
      ['a missing reference', created({ reference: undefined })],
    ])('returns INVALID_RESPONSE for %s', async (_label, body) => {
      nock(BASE_URL)
        .post(CREATE_PATH)
        .reply(201, body as nock.Body);
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error.kind).toBe('INVALID_RESPONSE');
    });

    it('returns INVALID_RESPONSE for a redirect, without following it', async () => {
      nock(BASE_URL).post(CREATE_PATH).reply(302, '', { Location: 'https://elsewhere.test/' });
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: '302' });
    });
  });

  describe('secret parameters', () => {
    it('returns UNAVAILABLE and sends nothing when a parameter cannot be read', async () => {
      ssm.reset();
      ssm
        .on(GetParameterCommand)
        .rejects(Object.assign(new Error(`denied ${PRIVATE_VALUE}`), { name: 'AccessDenied' }));
      const creation = nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      const error = (await build().create(request))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: 'SecretUnavailable:AccessDenied' });
      expect(creation.isDone()).toBe(false);
    });
  });

  describe('secrets, tokens and bodies stay out of errors and logs', () => {
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

    const sensitiveFragments = [
      PRIVATE_VALUE,
      INTEGRITY_VALUE,
      CARD_VALUE,
      ACCEPTANCE_VALUE,
      PERSONAL_AUTH_VALUE,
      expectedHex,
      'Bearer',
      BASE_URL,
      'echoed-body-text',
    ];
    const assertNoLeak = (value: unknown): void => {
      const serialized = JSON.stringify(value);
      for (const fragment of sensitiveFragments) {
        expect(serialized).not.toContain(fragment);
      }
    };
    const echoes = `echoed-body-text ${PRIVATE_VALUE} ${INTEGRITY_VALUE} ${CARD_VALUE} ${expectedHex}`;

    it.each([
      [
        '4xx whose body echoes every secret',
        () =>
          nock(BASE_URL)
            .post(CREATE_PATH)
            .reply(422, { error: { type: 'INPUT_VALIDATION_ERROR', messages: [echoes] } }),
      ],
      [
        '4xx whose type echoes a secret',
        () =>
          nock(BASE_URL)
            .post(CREATE_PATH)
            .reply(422, { error: { type: echoes } }),
      ],
      [
        '5xx twice whose body echoes every secret',
        () => nock(BASE_URL).post(CREATE_PATH).times(2).reply(500, echoes),
      ],
      [
        '5xx then 4xx',
        () =>
          nock(BASE_URL)
            .post(CREATE_PATH)
            .reply(500, echoes)
            .post(CREATE_PATH)
            .reply(400, { error: { type: 'BAD_THING', messages: echoes } }),
      ],
      [
        'a malformed success body',
        () =>
          nock(BASE_URL)
            .post(CREATE_PATH)
            .reply(201, { data: { leaked: echoes } }),
      ],
      ['a body that is not JSON', () => nock(BASE_URL).post(CREATE_PATH).reply(201, echoes)],
      [
        'a network failure that echoes secrets',
        () => nock(BASE_URL).post(CREATE_PATH).replyWithError(`fail ${echoes}`),
      ],
      [
        'a timeout',
        () => nock(BASE_URL).post(CREATE_PATH).times(2).delayConnection(1_000).reply(201, echoes),
      ],
    ])('%s: the error value and captured output hold no secret', async (_label, setup) => {
      setup();
      const error = (await build().create(request))._unsafeUnwrapErr();
      assertNoLeak(error);
      for (const spy of logSpies) {
        for (const call of spy.mock.calls) {
          assertNoLeak(call);
        }
      }
    });

    it('a secret-read failure echoing the secret leaks nothing', async () => {
      ssm.reset();
      ssm
        .on(GetParameterCommand)
        .rejects(Object.assign(new Error(echoes), { name: 'AccessDenied' }));
      const error = (await build().create(request))._unsafeUnwrapErr();
      assertNoLeak(error);
      for (const spy of logSpies) {
        for (const call of spy.mock.calls) {
          assertNoLeak(call);
        }
      }
    });

    it('a successful call logs nothing', async () => {
      nock(BASE_URL).post(CREATE_PATH).reply(201, created());
      expect((await build().create(request)).isOk()).toBe(true);
      for (const spy of logSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe('Standard_Profile timing with fake timers', () => {
    // fetch is stubbed here so only the adapter and the policy timers run under fake time.
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      fetchSpy = jest.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    });

    // Lets the SSM mock and promise chains settle on the real event loop.
    const settle = async (): Promise<void> => {
      for (let round = 0; round < 5; round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await jest.advanceTimersByTimeAsync(0);
      }
    };

    it('waits 500 ms before the retry after a 5xx', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 })));
      const pending = build(STANDARD_PROFILE_TIMING).create(request);
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(499);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect((await pending)._unsafeUnwrapErr()).toEqual({ kind: 'UNAVAILABLE', reason: '500' });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('times out after 10 s, retries after 500 ms and gives UNAVAILABLE on a second timeout', async () => {
      fetchSpy.mockImplementation(() => new Promise<Response>(() => undefined));
      const pending = build(STANDARD_PROFILE_TIMING).create(request);
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await jest.advanceTimersByTimeAsync(499);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(10_000);
      expect((await pending)._unsafeUnwrapErr()).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'AbortError',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
