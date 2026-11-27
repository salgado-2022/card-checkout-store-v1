import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import nock from 'nock';
import { resetSsmParameterCacheForTests, SsmParameterReader } from '../config/ssm-parameter-reader';
import { PaymentGatewayAdapter } from './payment-gateway.adapter';

const BASE_URL = 'https://payment.test';
const PRIVATE_PARAM = '/test/payment/private-key';
const PRIVATE_VALUE = 'prv_test_fake';
const EXTERNAL_ID = 'ext-test-001';
const REFERENCE = 'ORD-TEST-0001';
const echoes = `echoed-body-text ${PRIVATE_VALUE}`;

const config = {
  paymentApiUrl: BASE_URL,
  paymentPublicKey: 'pub_test_fake',
  paymentPrivateKeyParam: PRIVATE_PARAM,
  paymentIntegritySecretParam: '/test/payment/integrity-secret',
};
const standardTiming = { attemptTimeoutMs: 10_000, backoffMs: 500 };
const build = (): PaymentGatewayAdapter =>
  new PaymentGatewayAdapter(config, standardTiming, new SsmParameterReader());

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: EXTERNAL_ID,
  status: 'APPROVED',
  status_message: null,
  reference: REFERENCE,
  amount_in_cents: 25_100_000,
  currency: 'COP',
  customer_email: 'buyer@example.test',
  created_at: '2026-11-27T10:00:00Z',
  ...overrides,
});
const mapped = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'APPROVED',
  message: null,
  amountInCents: 25_100_000,
  currency: 'COP',
  reference: REFERENCE,
  ...overrides,
});
const statusPath = `/transactions/${EXTERNAL_ID}`;
const lookupPath = `/transactions?reference=${REFERENCE}`;

describe('PaymentGatewayAdapter read methods (Single_Attempt_Profile)', () => {
  const ssm = mockClient(SSMClient);
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    nock.cleanAll();
    resetSsmParameterCacheForTests();
    ssm.reset();
    ssm.on(GetParameterCommand, { Name: PRIVATE_PARAM }).resolves({
      Parameter: { Value: PRIVATE_VALUE },
    });
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

  afterAll(() => {
    ssm.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  const assertNoLeak = (value: unknown): void => {
    const serialized = JSON.stringify(value);
    for (const fragment of [PRIVATE_VALUE, 'Bearer', BASE_URL, 'echoed-body-text']) {
      expect(serialized).not.toContain(fragment);
    }
  };

  describe('getStatus', () => {
    it.each([
      ['PENDING', null],
      ['APPROVED', null],
      ['DECLINED', 'Fondos insuficientes'],
      ['VOIDED', 'Anulada'],
      ['ERROR', 'Error del emisor'],
    ])('maps %s with its message, amount, currency and reference', async (status, message) => {
      nock(BASE_URL)
        .get(statusPath)
        .reply(200, { data: record({ status, status_message: message }), meta: {} });
      const result = await build().getStatus(EXTERNAL_ID);
      expect(result._unsafeUnwrap()).toEqual(mapped({ status, message }));
    });

    it.each(['..', '../merchants/x', '', 'ext id'])(
      'rejects the external id %j before any request is sent',
      async (externalId) => {
        const scope = nock(BASE_URL).get(/.*/).reply(200, {});
        const error = (await build().getStatus(externalId))._unsafeUnwrapErr();
        expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: 'InvalidIdentifier' });
        expect(scope.isDone()).toBe(false);
        nock.cleanAll();
      },
    );

    it('treats a missing status_message as null', async () => {
      const withoutMessage = record({ status_message: undefined });
      nock(BASE_URL).get(statusPath).reply(200, { data: withoutMessage });
      expect((await build().getStatus(EXTERNAL_ID))._unsafeUnwrap()).toEqual(mapped());
    });

    it('sends the private key as a bearer header to the external id path', async () => {
      const scope = nock(BASE_URL, { reqheaders: { authorization: `Bearer ${PRIVATE_VALUE}` } })
        .get('/transactions/15113-1795789691-10756')
        .reply(200, { data: record() });
      const result = await build().getStatus('15113-1795789691-10756');
      expect(result.isOk()).toBe(true);
      expect(scope.isDone()).toBe(true);
    });

    it('ignores trailing slashes of the configured base URL', async () => {
      nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      const adapter = new PaymentGatewayAdapter(
        { ...config, paymentApiUrl: `${BASE_URL}//` },
        standardTiming,
        new SsmParameterReader(),
      );
      expect((await adapter.getStatus(EXTERNAL_ID)).isOk()).toBe(true);
    });

    it.each([
      ['a full record', record({ status: 'CHARGEBACK' })],
      ['a record with only a status', { status: 'CHARGEBACK' }],
      ['a lower-case known status', record({ status: 'approved' })],
    ])('maps %s with an unrecognized status to UNKNOWN', async (_label, data) => {
      nock(BASE_URL).get(statusPath).reply(200, { data });
      expect((await build().getStatus(EXTERNAL_ID))._unsafeUnwrap()).toEqual({
        status: 'UNKNOWN',
      });
    });

    it.each([
      ['a known status without an amount', record({ amount_in_cents: undefined })],
      ['a fractional amount', record({ amount_in_cents: 10.5 })],
      ['a record without a status', { id: EXTERNAL_ID }],
      ['a null record', null],
    ])('gives INVALID_RESPONSE for %s', async (_label, data) => {
      nock(BASE_URL).get(statusPath).reply(200, { data });
      expect((await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SchemaMismatch',
      });
    });

    it('gives INVALID_RESPONSE for a body that is not an object or not JSON', async () => {
      nock(BASE_URL).get(statusPath).reply(200, 'not json at all');
      expect((await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SyntaxError',
      });
      nock(BASE_URL).get(statusPath).reply(200, 'null', { 'content-type': 'application/json' });
      expect((await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SchemaMismatch',
      });
    });

    it('maps 401 INVALID_ACCESS_TOKEN to REJECTED after one request', async () => {
      const first = nock(BASE_URL)
        .get(statusPath)
        .reply(401, { error: { type: 'INVALID_ACCESS_TOKEN', reason: echoes } });
      const second = nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      const error = (await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'INVALID_ACCESS_TOKEN',
        afterTransientFailure: false,
      });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it.each([400, 403, 404, 422])('maps %i to REJECTED after exactly one request', async (code) => {
      const first = nock(BASE_URL).get(statusPath).reply(code, 'plain text body');
      const second = nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      const error = (await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'PROVIDER_REJECTED',
        afterTransientFailure: false,
      });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it.each([500, 502, 503])('maps %i to UNAVAILABLE after exactly one request', async (code) => {
      const first = nock(BASE_URL).get(statusPath).reply(code, echoes);
      const second = nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      const error = (await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: String(code) });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it('maps a transport failure to UNAVAILABLE after one request', async () => {
      const first = nock(BASE_URL).get(statusPath).replyWithError(`socket ${echoes}`);
      const second = nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      const error = (await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr();
      expect(error.kind).toBe('UNAVAILABLE');
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it('sends nothing and gives UNAVAILABLE when the private key cannot be read', async () => {
      ssm.reset();
      ssm
        .on(GetParameterCommand)
        .rejects(Object.assign(new Error(`denied ${PRIVATE_VALUE}`), { name: 'AccessDenied' }));
      const request = nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      const error = (await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: 'SecretUnavailable:AccessDenied' });
      expect(request.isDone()).toBe(false);
    });

    it('never sends a creation request', async () => {
      const creation = nock(BASE_URL).post(/.*/).reply(201, {});
      nock(BASE_URL).get(statusPath).reply(500, 'boom');
      await build().getStatus(EXTERNAL_ID);
      expect(creation.isDone()).toBe(false);
    });
  });

  describe('findByReference', () => {
    it('sends the private key as a query parameter lookup and finds one record', async () => {
      const scope = nock(BASE_URL, { reqheaders: { authorization: `Bearer ${PRIVATE_VALUE}` } })
        .get('/transactions')
        .query({ reference: REFERENCE })
        .reply(200, { data: [record()], meta: {} });
      const result = await build().findByReference(REFERENCE);
      expect(result._unsafeUnwrap()).toEqual({
        kind: 'found',
        externalId: EXTERNAL_ID,
        status: mapped(),
      });
      expect(scope.isDone()).toBe(true);
    });

    it('keeps a 404 as an error, not as "no record", so the transaction stays PENDING', async () => {
      nock(BASE_URL)
        .get(lookupPath)
        .reply(404, { error: { type: 'NOT_FOUND_ERROR' } });
      const error = (await build().findByReference(REFERENCE))._unsafeUnwrapErr();
      expect(error.kind).toBe('REJECTED');
    });

    it.each(['ORD A&B', '../merchants', '', 'x'.repeat(129)])(
      'rejects the reference %j before any request is sent',
      async (reference) => {
        const scope = nock(BASE_URL).get(/.*/).reply(200, { data: [] });
        const error = (await build().findByReference(reference))._unsafeUnwrapErr();
        expect(error).toEqual({ kind: 'INVALID_RESPONSE', reason: 'InvalidIdentifier' });
        expect(scope.isDone()).toBe(false);
        nock.cleanAll();
      },
    );

    it('carries the provider message of a found DECLINED record', async () => {
      nock(BASE_URL)
        .get(lookupPath)
        .reply(200, { data: [record({ status: 'DECLINED', status_message: 'Rechazada' })] });
      const outcome = (await build().findByReference(REFERENCE))._unsafeUnwrap();
      expect(outcome).toEqual({
        kind: 'found',
        externalId: EXTERNAL_ID,
        status: mapped({ status: 'DECLINED', message: 'Rechazada' }),
      });
    });

    it('picks the record whose reference matches exactly among several', async () => {
      nock(BASE_URL)
        .get(lookupPath)
        .reply(200, {
          data: [
            record({ id: 'ext-other-1', reference: `${REFERENCE}-X`, status: 'DECLINED' }),
            record({ id: 'ext-exact', status: 'PENDING' }),
            record({ id: 'ext-other-2', reference: 'ord-test-0001' }),
          ],
        });
      const outcome = (await build().findByReference(REFERENCE))._unsafeUnwrap();
      expect(outcome).toEqual({
        kind: 'found',
        externalId: 'ext-exact',
        status: mapped({ status: 'PENDING' }),
      });
    });

    it('accepts a single record object in place of an array', async () => {
      nock(BASE_URL).get(lookupPath).reply(200, { data: record() });
      const outcome = (await build().findByReference(REFERENCE))._unsafeUnwrap();
      expect(outcome).toEqual({ kind: 'found', externalId: EXTERNAL_ID, status: mapped() });
    });

    it('keeps the external id when the found record has an unknown status', async () => {
      nock(BASE_URL)
        .get(lookupPath)
        .reply(200, { data: [record({ status: 'CHARGEBACK' })] });
      const outcome = (await build().findByReference(REFERENCE))._unsafeUnwrap();
      expect(outcome).toEqual({
        kind: 'found',
        externalId: EXTERNAL_ID,
        status: { status: 'UNKNOWN' },
      });
    });

    it('gives INVALID_RESPONSE for a match with an unknown status and no id', async () => {
      nock(BASE_URL)
        .get(lookupPath)
        .reply(200, { data: [{ reference: REFERENCE, status: 'CHARGEBACK' }] });
      expect((await build().findByReference(REFERENCE))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SchemaMismatch',
      });
    });

    it.each([
      ['an empty array', 200, { data: [], meta: {} }],
      ['a null transaction', 200, { data: null }],
      [
        'several records and none with an exact reference',
        200,
        {
          data: [
            record({ reference: `${REFERENCE}-X` }),
            record({ reference: 'ord-test-0001' }),
            { id: 'ext-no-reference' },
            null,
          ],
        },
      ],
    ])('maps %s to Ok(not_found) after one request', async (_label, code, body) => {
      const first = nock(BASE_URL).get(lookupPath).reply(code, body);
      const second = nock(BASE_URL)
        .get(lookupPath)
        .reply(200, { data: [record()] });
      const outcome = (await build().findByReference(REFERENCE))._unsafeUnwrap();
      expect(outcome).toEqual({ kind: 'not_found' });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it('maps 401 INVALID_ACCESS_TOKEN to REJECTED after one request', async () => {
      const first = nock(BASE_URL)
        .get(lookupPath)
        .reply(401, { error: { type: 'INVALID_ACCESS_TOKEN', reason: echoes } });
      const second = nock(BASE_URL).get(lookupPath).reply(200, { data: [] });
      const error = (await build().findByReference(REFERENCE))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'INVALID_ACCESS_TOKEN',
        afterTransientFailure: false,
      });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it.each([400, 403, 422])('maps %i to REJECTED after exactly one request', async (code) => {
      const first = nock(BASE_URL).get(lookupPath).reply(code, '');
      const second = nock(BASE_URL).get(lookupPath).reply(200, { data: [] });
      const error = (await build().findByReference(REFERENCE))._unsafeUnwrapErr();
      expect(error).toEqual({
        kind: 'REJECTED',
        providerMessage: 'PROVIDER_REJECTED',
        afterTransientFailure: false,
      });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it.each([500, 503])('maps %i to UNAVAILABLE after exactly one request', async (code) => {
      const first = nock(BASE_URL).get(lookupPath).reply(code, echoes);
      const second = nock(BASE_URL).get(lookupPath).reply(200, { data: [] });
      const error = (await build().findByReference(REFERENCE))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: String(code) });
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it('maps a transport failure to UNAVAILABLE after one request', async () => {
      const first = nock(BASE_URL).get(lookupPath).replyWithError(`socket ${echoes}`);
      const second = nock(BASE_URL).get(lookupPath).reply(200, { data: [] });
      const error = (await build().findByReference(REFERENCE))._unsafeUnwrapErr();
      expect(error.kind).toBe('UNAVAILABLE');
      expect(first.isDone()).toBe(true);
      expect(second.isDone()).toBe(false);
    });

    it('gives INVALID_RESPONSE for a body that is not JSON or not an object', async () => {
      nock(BASE_URL).get(lookupPath).reply(200, 'not json at all');
      expect((await build().findByReference(REFERENCE))._unsafeUnwrapErr().kind).toBe(
        'INVALID_RESPONSE',
      );
      nock(BASE_URL).get(lookupPath).reply(200, '[]', { 'content-type': 'application/json' });
      expect((await build().findByReference(REFERENCE))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SchemaMismatch',
      });
    });

    it('gives INVALID_RESPONSE for a body without a data key', async () => {
      nock(BASE_URL).get(lookupPath).reply(200, {});
      expect((await build().findByReference(REFERENCE))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SchemaMismatch',
      });
    });

    it('gives INVALID_RESPONSE for an exact match that fails the schema', async () => {
      nock(BASE_URL)
        .get(lookupPath)
        .reply(200, { data: [record({ amount_in_cents: 'many' })] });
      expect((await build().findByReference(REFERENCE))._unsafeUnwrapErr()).toEqual({
        kind: 'INVALID_RESPONSE',
        reason: 'SchemaMismatch',
      });
    });

    it('sends nothing and gives UNAVAILABLE when the private key cannot be read', async () => {
      ssm.reset();
      ssm.on(GetParameterCommand).rejects(Object.assign(new Error('x'), { name: 'AccessDenied' }));
      const request = nock(BASE_URL).get(lookupPath).reply(200, { data: [] });
      const error = (await build().findByReference(REFERENCE))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'UNAVAILABLE', reason: 'SecretUnavailable:AccessDenied' });
      expect(request.isDone()).toBe(false);
    });

    it('never sends a creation request', async () => {
      const creation = nock(BASE_URL).post(/.*/).reply(201, {});
      nock(BASE_URL).get(lookupPath).reply(200, { data: [] });
      await build().findByReference(REFERENCE);
      expect(creation.isDone()).toBe(false);
    });
  });

  describe('secrets, tokens and bodies stay out of errors and logs', () => {
    it.each([
      [
        'getStatus 4xx echoing the key',
        () =>
          nock(BASE_URL)
            .get(statusPath)
            .reply(401, { error: { type: echoes } }),
        () => build().getStatus(EXTERNAL_ID),
      ],
      [
        'getStatus 5xx echoing the key',
        () => nock(BASE_URL).get(statusPath).reply(500, echoes),
        () => build().getStatus(EXTERNAL_ID),
      ],
      [
        'getStatus malformed body',
        () =>
          nock(BASE_URL)
            .get(statusPath)
            .reply(200, { data: { leaked: echoes } }),
        () => build().getStatus(EXTERNAL_ID),
      ],
      [
        'getStatus transport failure',
        () => nock(BASE_URL).get(statusPath).replyWithError(`fail ${echoes}`),
        () => build().getStatus(EXTERNAL_ID),
      ],
      [
        'findByReference 4xx echoing the key',
        () =>
          nock(BASE_URL)
            .get(lookupPath)
            .reply(403, { error: { type: echoes } }),
        () => build().findByReference(REFERENCE),
      ],
      [
        'findByReference 5xx echoing the key',
        () => nock(BASE_URL).get(lookupPath).reply(502, echoes),
        () => build().findByReference(REFERENCE),
      ],
      [
        'findByReference malformed match',
        () =>
          nock(BASE_URL)
            .get(lookupPath)
            .reply(200, { data: [{ reference: REFERENCE, status: 'APPROVED', leaked: echoes }] }),
        () => build().findByReference(REFERENCE),
      ],
      [
        'findByReference transport failure',
        () => nock(BASE_URL).get(lookupPath).replyWithError(`fail ${echoes}`),
        () => build().findByReference(REFERENCE),
      ],
    ])('%s: the error value and captured output hold no secret', async (_label, setup, run) => {
      setup();
      const error = (await run())._unsafeUnwrapErr();
      assertNoLeak(error);
      for (const spy of logSpies) {
        for (const call of spy.mock.calls) {
          assertNoLeak(call);
        }
      }
    });

    it('a secret-read failure echoing the key leaks nothing', async () => {
      ssm.reset();
      ssm
        .on(GetParameterCommand)
        .rejects(Object.assign(new Error(echoes), { name: 'AccessDenied' }));
      assertNoLeak((await build().getStatus(EXTERNAL_ID))._unsafeUnwrapErr());
      assertNoLeak((await build().findByReference(REFERENCE))._unsafeUnwrapErr());
    });

    it('successful calls log nothing', async () => {
      nock(BASE_URL).get(statusPath).reply(200, { data: record() });
      nock(BASE_URL)
        .get(lookupPath)
        .reply(200, { data: [record()] });
      await build().getStatus(EXTERNAL_ID);
      await build().findByReference(REFERENCE);
      for (const spy of logSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe('3 s timeout with fake timers', () => {
    // fetch is stubbed so only the adapter and the policy timers run under fake time.
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      fetchSpy = jest.spyOn(globalThis, 'fetch');
      fetchSpy.mockImplementation(() => new Promise<Response>(() => undefined));
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    });

    const settle = async (): Promise<void> => {
      for (let round = 0; round < 5; round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await jest.advanceTimersByTimeAsync(0);
      }
    };

    it.each([
      ['getStatus', () => build().getStatus(EXTERNAL_ID)],
      ['findByReference', () => build().findByReference(REFERENCE)],
    ])('%s gives UNAVAILABLE at 3 s and makes no second request', async (_label, run) => {
      const pending = run();
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect((await pending)._unsafeUnwrapErr()).toEqual({
        kind: 'UNAVAILABLE',
        reason: 'AbortError',
      });
      await jest.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
