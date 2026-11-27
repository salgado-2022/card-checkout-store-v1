import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import nock from 'nock';
import type { Result } from 'neverthrow';
import type { PaymentGatewayError } from '../../application/errors';
import { resetSsmParameterCacheForTests, SsmParameterReader } from '../config/ssm-parameter-reader';
import { PaymentGatewayAdapter } from './payment-gateway.adapter';
import { SINGLE_ATTEMPT_PROFILE_TIMING } from './provider-call-policy';

// Feature: payments-api, Property 9: Provider resilience policy is profile-specific (Single_Attempt_Profile part)

const BASE_URL = 'https://payment.test';
const PRIVATE_PARAM = '/test/payment/private-key';
const PRIVATE_VALUE = 'prv_test_fake';
const NUM_RUNS = 100;
const PROPERTY_TIMEOUT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 3_000;
const HANG_DELAY_MS = 10_000;
const SETTLE_ROUNDS = 50;

const config = {
  paymentApiUrl: BASE_URL,
  paymentPublicKey: 'pub_test_fake',
  paymentPrivateKeyParam: PRIVATE_PARAM,
  paymentIntegritySecretParam: '/test/payment/integrity-secret',
};

/** Simulated provider answer for the one attempt. */
type Outcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'client'; readonly status: number }
  | { readonly kind: 'server'; readonly status: number }
  | { readonly kind: 'timeout' };

/** The `error.type` the provider sends with each 4xx. The adapter keeps it as `providerMessage`. */
const CLIENT_ERROR_TYPE: Readonly<Record<number, string>> = {
  400: 'INVALID_PARAMETER',
  401: 'INVALID_ACCESS_TOKEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
};

const outcomeArbitrary: fc.Arbitrary<Outcome> = fc.oneof(
  fc.constant<Outcome>({ kind: 'success' }),
  fc.constant<Outcome>({ kind: 'not_found' }),
  fc.constantFrom(400, 401, 404, 409, 422).map<Outcome>((status) => ({ kind: 'client', status })),
  fc.constantFrom(500, 502, 503).map<Outcome>((status) => ({ kind: 'server', status })),
  fc.constant<Outcome>({ kind: 'timeout' }),
);

const referenceArbitrary = fc.stringMatching(/^ORD-[0-9A-Z]{26}$/);
const externalIdArbitrary = fc.stringMatching(/^ext-[a-z0-9]{6,20}$/);

/** Result as a plain object, so `toEqual` compares the outcome and not neverthrow's class. */
type Plain = { readonly ok: unknown } | { readonly err: PaymentGatewayError };

function plain<T>(result: Result<T, PaymentGatewayError>): Plain {
  return result.match<Plain>(
    (value) => ({ ok: value }),
    (error) => ({ err: error }),
  );
}

function record(externalId: string, reference: string): Record<string, unknown> {
  return {
    id: externalId,
    status: 'APPROVED',
    status_message: null,
    reference,
    amount_in_cents: 25_100_000,
    currency: 'COP',
  };
}

const mappedStatus = (reference: string): Record<string, unknown> => ({
  status: 'APPROVED',
  message: null,
  amountInCents: 25_100_000,
  currency: 'COP',
  reference,
});

/** The Single_Attempt_Profile result that each outcome must produce, for one method. */
function failureFor(outcome: Outcome): Plain {
  if (outcome.kind === 'client') {
    return {
      err: {
        kind: 'REJECTED',
        providerMessage: CLIENT_ERROR_TYPE[outcome.status] ?? 'PROVIDER_REJECTED',
        afterTransientFailure: false,
      },
    };
  }
  if (outcome.kind === 'server') {
    return { err: { kind: 'UNAVAILABLE', reason: String(outcome.status) } };
  }
  return { err: { kind: 'UNAVAILABLE', reason: 'AbortError' } };
}

interface Method {
  readonly name: 'getStatus' | 'findByReference';
  readonly run: (adapter: PaymentGatewayAdapter, externalId: string, reference: string) => unknown;
  /** Request path and query the provider receives. */
  readonly request: { readonly path: (externalId: string, reference: string) => string };
  /** Reply for a non-timeout outcome: status and JSON body. */
  readonly replyFor: (outcome: Outcome, externalId: string, reference: string) => [number, unknown];
  /** Expected final result. A timeout is handled by the caller and never reaches this function. */
  readonly expectedFor: (outcome: Outcome, externalId: string, reference: string) => Plain;
}

const METHODS: readonly Method[] = [
  {
    name: 'getStatus',
    run: (adapter, externalId) => adapter.getStatus(externalId),
    request: { path: (externalId) => `/transactions/${externalId}` },
    replyFor: (outcome, externalId, reference) => {
      if (outcome.kind === 'success') return [200, { data: record(externalId, reference) }];
      if (outcome.kind === 'client') {
        return [outcome.status, { error: { type: CLIENT_ERROR_TYPE[outcome.status] } }];
      }
      if (outcome.kind === 'server') return [outcome.status, {}];
      // A missing record on the status request is an ordinary 4xx: there is no lookup semantics.
      return [404, { error: { type: CLIENT_ERROR_TYPE[404] } }];
    },
    expectedFor: (outcome, _externalId, reference) => {
      if (outcome.kind === 'success') return { ok: mappedStatus(reference) };
      return failureFor(outcome.kind === 'not_found' ? { kind: 'client', status: 404 } : outcome);
    },
  },
  {
    name: 'findByReference',
    run: (adapter, _externalId, reference) => adapter.findByReference(reference),
    request: { path: (_externalId, reference) => `/transactions?reference=${reference}` },
    replyFor: (outcome, externalId, reference) => {
      if (outcome.kind === 'success') return [200, { data: [record(externalId, reference)] }];
      if (outcome.kind === 'not_found') return [200, { data: [], meta: {} }];
      if (outcome.kind === 'client') {
        return [outcome.status, { error: { type: CLIENT_ERROR_TYPE[outcome.status] } }];
      }
      if (outcome.kind === 'server') return [outcome.status, {}];
      return [200, { data: [record(externalId, reference)] }];
    },
    expectedFor: (outcome, externalId, reference) => {
      if (outcome.kind === 'success') {
        return {
          ok: {
            kind: 'found',
            externalId,
            status: mappedStatus(reference),
          },
        };
      }
      // Only an empty result is a clean "no such reference". A 404 is an ordinary client error.
      if (outcome.kind === 'not_found') {
        return { ok: { kind: 'not_found' } };
      }
      return failureFor(outcome);
    },
  },
];

/**
 * Registers the one interceptor the single attempt may match, plus a sentinel on the same path
 * that counts any second request. A timeout is an interceptor that replies after HANG_DELAY_MS,
 * which is longer than the 3 s attempt timeout.
 */
function registerAttempt(
  method: Method,
  outcome: Outcome,
  externalId: string,
  reference: string,
): { readonly retries: () => number } {
  const url = new URL(method.request.path(externalId, reference), BASE_URL);
  const query = url.search === '' ? undefined : Object.fromEntries(url.searchParams);
  const scope = nock(BASE_URL);
  let retries = 0;
  const target = (): nock.Interceptor => {
    const interceptor = scope.get(url.pathname);
    return query === undefined ? interceptor : interceptor.query(query);
  };
  const primary = target();
  const delayed = outcome.kind === 'timeout' ? primary.delayConnection(HANG_DELAY_MS) : primary;
  delayed.reply(() => method.replyFor(outcome, externalId, reference));
  target().reply(() => {
    retries += 1;
    return [200, { data: record(externalId, reference) }];
  });
  return { retries: () => retries };
}

/** Lets nock and the SSM mock run under fake timers; only `advance(0)` moves the fake clock. */
async function settleReal(isSettled: () => boolean): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS && !isSettled(); round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await jest.advanceTimersByTimeAsync(0);
  }
}

describe('Feature: payments-api, Property 9: Provider resilience policy is profile-specific (Single_Attempt_Profile part)', () => {
  const ssm = mockClient(SSMClient);

  beforeAll(() => {
    nock.disableNetConnect();
  });

  beforeEach(() => {
    nock.cleanAll();
    resetSsmParameterCacheForTests();
    ssm.reset();
    ssm.on(GetParameterCommand, { Name: PRIVATE_PARAM }).resolves({
      Parameter: { Value: PRIVATE_VALUE },
    });
    // Only the timers are faked, so the 3 s attempt timeout can be driven exactly. nextTick,
    // setImmediate and queueMicrotask stay real so the SSM mock, nock and fetch settle normally.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    jest.useRealTimers();
  });

  afterAll(() => {
    ssm.restore();
    nock.enableNetConnect();
  });

  it.each(METHODS.map((method) => [method.name, method] as const))(
    '%s makes exactly one attempt with a 3 s timeout and never retries, whatever the outcome',
    async (_name, method) => {
      expect(SINGLE_ATTEMPT_PROFILE_TIMING.attemptTimeoutMs).toBe(ATTEMPT_TIMEOUT_MS);
      await fc.assert(
        fc.asyncProperty(
          outcomeArbitrary,
          externalIdArbitrary,
          referenceArbitrary,
          async (outcome, externalId, reference) => {
            nock.cleanAll();
            const attempt = registerAttempt(method, outcome, externalId, reference);
            // Production timing: the Single_Attempt_Profile uses 3 s by default.
            const adapter = new PaymentGatewayAdapter(config, undefined, new SsmParameterReader());

            let settled: Plain | undefined;
            const pending = Promise.resolve(method.run(adapter, externalId, reference)).then(
              (result) => {
                // `await` unwraps the ResultAsync; the method's own type fixes the Result shape.
                settled = plain(result as Result<unknown, PaymentGatewayError>);
              },
            );

            await settleReal(() => settled !== undefined);
            if (outcome.kind === 'timeout') {
              expect(settled).toBeUndefined();
              await jest.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS - 1);
              await settleReal(() => false);
              expect(settled).toBeUndefined();
              await jest.advanceTimersByTimeAsync(1);
              await settleReal(() => settled !== undefined);
            }
            await pending;
            expect(settled).toEqual(method.expectedFor(outcome, externalId, reference));

            // Any retry would be scheduled after the first settles. Advance past every backoff.
            await jest.advanceTimersByTimeAsync(60_000);
            await settleReal(() => false);
            expect(attempt.retries()).toBe(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
