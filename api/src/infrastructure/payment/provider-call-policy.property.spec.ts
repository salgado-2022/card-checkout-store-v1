import * as fc from 'fast-check';
import nock from 'nock';
import type { Result } from 'neverthrow';
import type { PaymentGatewayError } from '../../application/errors';
import { PaymentGatewayAdapter } from './payment-gateway.adapter';
import {
  SINGLE_ATTEMPT_PROFILE_TIMING,
  withSingleAttemptProfile,
  withStandardProfile,
  type ProviderAttempt,
} from './provider-call-policy';

// Feature: payments-api, Property 9: Provider resilience policy is profile-specific (policy and Standard_Profile part)

const BASE_URL = 'https://payment.test';
const PUBLIC_KEY = 'pub_test_fake';
const MERCHANT_PATH = `/merchants/${PUBLIC_KEY}`;
const ACCEPTANCE_TOKEN = 'tok_test_fake_acceptance';
const PERSONAL_AUTH_TOKEN = 'tok_test_fake_personal';
const ACCEPTANCE_PERMALINK = 'https://payment.test/docs/acceptance';
const PERSONAL_AUTH_PERMALINK = 'https://payment.test/docs/personal-auth';

const validBody = {
  data: {
    presigned_acceptance: { acceptance_token: ACCEPTANCE_TOKEN, permalink: ACCEPTANCE_PERMALINK },
    presigned_personal_data_auth: {
      acceptance_token: PERSONAL_AUTH_TOKEN,
      permalink: PERSONAL_AUTH_PERMALINK,
    },
  },
};

const expectedTokens = {
  acceptanceToken: { token: ACCEPTANCE_TOKEN, permalink: ACCEPTANCE_PERMALINK },
  acceptPersonalAuth: { token: PERSONAL_AUTH_TOKEN, permalink: PERSONAL_AUTH_PERMALINK },
};

/**
 * Timings for the adapter property. The real timers run with small values so that 100 runs stay
 * fast. The attempt timeout must stay well above the time a local nock reply takes under full-suite
 * load (a 30 ms timeout let normal 502 replies time out intermittently), and the nock delay must
 * stay well above the timeout, so each outcome lands on the intended side.
 */
const FAST_TIMING = { attemptTimeoutMs: 100, backoffMs: 1 };
const HANG_DELAY_MS = 400;
const ADAPTER_PROPERTY_TIMEOUT_MS = 60_000;

/** Simulated provider outcome for one attempt. */
type Outcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'client'; readonly status: number }
  | { readonly kind: 'server'; readonly status: number }
  | { readonly kind: 'timeout' };

type Failure = Exclude<Outcome, { readonly kind: 'success' }>;

/** One outcome per possible attempt. The Standard_Profile makes at most two, so the third is a trap. */
type Sequence = readonly [Outcome, Outcome, Outcome];

interface Expectation {
  readonly attempts: number;
  readonly error?: PaymentGatewayError;
}

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.constant<Outcome>({ kind: 'success' }),
  fc.constantFrom(400, 401, 404, 409, 422).map<Outcome>((status) => ({ kind: 'client', status })),
  fc.constantFrom(500, 502, 503, 504).map<Outcome>((status) => ({ kind: 'server', status })),
  fc.constant<Outcome>({ kind: 'timeout' }),
);

const sequenceArb: fc.Arbitrary<Sequence> = fc.tuple(outcomeArb, outcomeArb, outcomeArb);

/** The error the policy must return for a failing attempt. */
function failureOf(outcome: Failure, afterTransientFailure: boolean): PaymentGatewayError {
  if (outcome.kind === 'client') {
    return {
      kind: 'REJECTED',
      providerMessage: `HTTP ${outcome.status}`,
      afterTransientFailure,
    };
  }
  if (outcome.kind === 'server') return { kind: 'UNAVAILABLE', reason: String(outcome.status) };
  return { kind: 'UNAVAILABLE', reason: 'AbortError' };
}

/**
 * Oracle for the Standard_Profile. The second attempt happens only after a timeout or 5xx. A 4xx
 * never retries. The retry outcome decides the final result.
 */
function expectedStandard(sequence: Sequence): Expectation {
  const [first, second] = sequence;
  if (first.kind === 'success') return { attempts: 1 };
  if (first.kind === 'client') return { attempts: 1, error: failureOf(first, false) };
  if (second.kind === 'success') return { attempts: 2 };
  return { attempts: 2, error: failureOf(second, true) };
}

/** Oracle for the Single_Attempt_Profile: one attempt, whatever the outcome. */
function expectedSingle(outcome: Outcome): Expectation {
  if (outcome.kind === 'success') return { attempts: 1 };
  return { attempts: 1, error: failureOf(outcome, false) };
}

/** Plays one outcome as the provider would: a timeout waits for the signal to abort. */
function respond(outcome: Outcome, signal: AbortSignal): Promise<Response> {
  if (outcome.kind === 'timeout') {
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      );
    });
  }
  const status = outcome.kind === 'success' ? 200 : outcome.status;
  return Promise.resolve(new Response(null, { status }));
}

type ProfileResult = Result<Response, PaymentGatewayError>;

/** Status and body nock sends for an outcome. A timeout sends a valid body, late. */
function replyFor(outcome: Outcome): [number, unknown] {
  if (outcome.kind === 'client' || outcome.kind === 'server') return [outcome.status, {}];
  return [200, validBody];
}

interface ScriptedAttempt {
  readonly attempt: ProviderAttempt;
  readonly signals: readonly AbortSignal[];
}

/** Builds an attempt that plays `sequence` in call order and records every signal it receives. */
function scriptedAttempt(sequence: readonly Outcome[]): ScriptedAttempt {
  const signals: AbortSignal[] = [];
  const attempt: ProviderAttempt = (signal) => {
    const outcome = sequence[signals.length];
    signals.push(signal);
    if (outcome === undefined) throw new Error('unexpected attempt');
    return respond(outcome, signal);
  };
  return { attempt, signals };
}

describe('Feature: payments-api, Property 9: Provider resilience policy is profile-specific (policy and Standard_Profile part)', () => {
  describe('withStandardProfile with fake timers and the default timing', () => {
    // Technique: jest fake timers. The attempts respect the AbortSignal, so the 10 s timer really
    // aborts them. runAllTimersAsync advances past the timeout and the 500 ms backoff at once.
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('retries only after a timeout or 5xx, never after 4xx, never a third time, with a coherent result', async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (sequence) => {
          const scripted = scriptedAttempt(sequence);
          const expected = expectedStandard(sequence);

          const pending = withStandardProfile(scripted.attempt);
          await jest.runAllTimersAsync();
          const result: ProfileResult = await pending;

          expect(scripted.signals).toHaveLength(expected.attempts);
          if (expected.error === undefined) {
            expect(result._unsafeUnwrap().status).toBe(200);
          } else {
            expect(result._unsafeUnwrapErr()).toEqual(expected.error);
          }
          expect(jest.getTimerCount()).toBe(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('withSingleAttemptProfile with fake timers and the default timing', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('makes exactly one attempt for every outcome and aborts a timeout at 3 s, not before', async () => {
      expect(SINGLE_ATTEMPT_PROFILE_TIMING.attemptTimeoutMs).toBe(3_000);

      await fc.assert(
        fc.asyncProperty(outcomeArb, async (outcome) => {
          const scripted = scriptedAttempt([outcome]);
          const expected = expectedSingle(outcome);
          let settled = false;
          const markSettled = (value: ProfileResult): ProfileResult => {
            settled = true;
            return value;
          };
          const pending: PromiseLike<ProfileResult> = withSingleAttemptProfile(
            scripted.attempt,
          ).then(markSettled);

          if (outcome.kind === 'timeout') {
            await jest.advanceTimersByTimeAsync(2_999);
            expect(settled).toBe(false);
            expect(scripted.signals[0]?.aborted).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(scripted.signals[0]?.aborted).toBe(true);
          }

          const result = await pending;
          await jest.advanceTimersByTimeAsync(60_000);

          expect(scripted.signals).toHaveLength(expected.attempts);
          if (expected.error === undefined) {
            expect(result._unsafeUnwrap().status).toBe(200);
          } else {
            expect(result._unsafeUnwrapErr()).toEqual(expected.error);
          }
          expect(jest.getTimerCount()).toBe(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('getAcceptanceTokens through the real adapter and nock', () => {
    // Technique: nock interceptors registered in order, one per possible attempt. A timeout is an
    // interceptor with delayConnection longer than the injected attempt timeout, so the policy
    // aborts it by timer. Each reply callback counts the requests nock serves. The count gives the
    // number of attempts made. pendingMocks() is not used because it deduplicates identical keys.
    // Real timers are used with the small FAST_TIMING, so no fake timers are needed here.
    const adapter = new PaymentGatewayAdapter(
      { paymentApiUrl: BASE_URL, paymentPublicKey: PUBLIC_KEY },
      FAST_TIMING,
    );

    function mockMerchant(sequence: Sequence): { readonly served: () => number } {
      let served = 0;
      const scope = nock(BASE_URL);
      for (const outcome of sequence) {
        const interceptor = scope.get(MERCHANT_PATH);
        const target =
          outcome.kind === 'timeout' ? interceptor.delayConnection(HANG_DELAY_MS) : interceptor;
        target.reply(() => {
          served += 1;
          return replyFor(outcome);
        });
      }
      return { served: () => served };
    }

    beforeAll(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.cleanAll();
    });

    afterAll(() => {
      nock.cleanAll();
      nock.enableNetConnect();
    });

    it(
      'makes the attempts the Standard_Profile allows and returns the coherent final result',
      async () => {
        await fc.assert(
          fc.asyncProperty(sequenceArb, async (sequence) => {
            nock.cleanAll();
            const scope = mockMerchant(sequence);
            const expected = expectedStandard(sequence);

            const result = await adapter.getAcceptanceTokens();

            expect(scope.served()).toBe(expected.attempts);
            if (expected.error === undefined) {
              expect(result._unsafeUnwrap()).toEqual(expectedTokens);
            } else {
              expect(result._unsafeUnwrapErr()).toEqual(expected.error);
            }
          }),
          { numRuns: 100 },
        );
      },
      ADAPTER_PROPERTY_TIMEOUT_MS,
    );
  });
});
