import { ResultAsync, err, ok, type Result } from 'neverthrow';
import type { PaymentGatewayError } from '../../application/errors';

/** One HTTP attempt against the payment provider. It must abort its request when `signal` fires. */
export type ProviderAttempt = (signal: AbortSignal) => Promise<Response>;

export interface SingleAttemptTiming {
  readonly attemptTimeoutMs: number;
}

export interface StandardTiming extends SingleAttemptTiming {
  readonly backoffMs: number;
}

/** Standard_Profile: 10 s per attempt, one retry after a 500 ms backoff. */
export const STANDARD_PROFILE_TIMING: StandardTiming = {
  attemptTimeoutMs: 10_000,
  backoffMs: 500,
};

/** Single_Attempt_Profile: 3 s for the only attempt. */
export const SINGLE_ATTEMPT_PROFILE_TIMING: SingleAttemptTiming = {
  attemptTimeoutMs: 3_000,
};

/** Reason recorded for a timeout. It is the name fetch gives to an aborted request. */
const TIMEOUT_REASON = 'AbortError';
/** Reason recorded when a thrown value is not an Error instance. */
const UNKNOWN_EXCEPTION_REASON = 'UnknownError';
/** Reason recorded when the provider body is larger than MAX_BODY_BYTES. */
const BODY_TOO_LARGE_REASON = 'BodyTooLarge';
/** Largest provider body the API buffers. Real provider payloads are a few kilobytes. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Statuses whose Response must be built without a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

type AttemptOutcome =
  | { readonly kind: 'success'; readonly response: Response }
  | {
      readonly kind: 'failure';
      readonly error: PaymentGatewayError;
      readonly retryable: boolean;
    };

/**
 * Runs `attempt` under the Standard_Profile: at most two attempts. The retry happens only when the
 * first attempt times out or answers 5xx, after `backoffMs`. A 4xx on the retry is `REJECTED` with
 * `afterTransientFailure: true`.
 */
export function withStandardProfile(
  attempt: ProviderAttempt,
  timing: StandardTiming = STANDARD_PROFILE_TIMING,
): ResultAsync<Response, PaymentGatewayError> {
  return new ResultAsync(runStandard(attempt, timing));
}

/**
 * Runs `attempt` under the Single_Attempt_Profile: exactly one attempt, no retry for any outcome.
 */
export function withSingleAttemptProfile(
  attempt: ProviderAttempt,
  timing: SingleAttemptTiming = SINGLE_ATTEMPT_PROFILE_TIMING,
): ResultAsync<Response, PaymentGatewayError> {
  return new ResultAsync(runSingleAttempt(attempt, timing));
}

async function runStandard(
  attempt: ProviderAttempt,
  timing: StandardTiming,
): Promise<Result<Response, PaymentGatewayError>> {
  const first = await runAttempt(attempt, timing.attemptTimeoutMs);
  if (first.kind === 'success') return ok(first.response);
  if (!first.retryable) return err(first.error);

  await sleep(timing.backoffMs);
  const second = await runAttempt(attempt, timing.attemptTimeoutMs);
  if (second.kind === 'success') return ok(second.response);
  return err(
    second.error.kind === 'REJECTED'
      ? { ...second.error, afterTransientFailure: true }
      : second.error,
  );
}

async function runSingleAttempt(
  attempt: ProviderAttempt,
  timing: SingleAttemptTiming,
): Promise<Result<Response, PaymentGatewayError>> {
  const outcome = await runAttempt(attempt, timing.attemptTimeoutMs);
  return outcome.kind === 'success' ? ok(outcome.response) : err(outcome.error);
}

/**
 * Makes one attempt and settles with its outcome. The timer covers the whole exchange, headers
 * and body: the body is buffered before the attempt settles, so a provider that sends headers fast
 * and the body slowly still times out. The timer aborts the request and settles the attempt even
 * when `attempt` ignores the signal, and it is cleared as soon as the attempt settles. The returned
 * promise never rejects.
 */
function runAttempt(attempt: ProviderAttempt, timeoutMs: number): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({
        kind: 'failure',
        retryable: true,
        error: { kind: 'UNAVAILABLE', reason: TIMEOUT_REASON },
      });
    }, timeoutMs);

    const settle = (outcome: AttemptOutcome): void => {
      clearTimeout(timer);
      resolve(outcome);
    };

    void new Promise<Response>((resolveResponse) => {
      resolveResponse(attempt(controller.signal));
    })
      .then(bufferBody)
      .then(
        (buffered) => settle(buffered === 'too_large' ? bodyTooLarge() : classify(buffered)),
        (error: unknown) => settle(networkFailure(error)),
      );
  });
}

/**
 * Reads the whole body (bounded by MAX_BODY_BYTES) and returns an equivalent Response whose body
 * is already in memory, so callers can still call `json()` without waiting on the network. A
 * declared Content-Length above the limit is rejected without reading the body.
 */
async function bufferBody(response: Response): Promise<Response | 'too_large'> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
    return 'too_large';
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return 'too_large';
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function bodyTooLarge(): AttemptOutcome {
  return {
    kind: 'failure',
    retryable: false,
    error: { kind: 'INVALID_RESPONSE', reason: BODY_TOO_LARGE_REASON },
  };
}

/**
 * Maps an HTTP response to an outcome. Only 5xx is retryable. A 4xx is never retried. Any other
 * status (for example 3xx, which fetch does not follow when redirects are manual) is an invalid
 * response.
 */
function classify(response: Response): AttemptOutcome {
  if (response.ok) return { kind: 'success', response };
  if (response.status >= 500) {
    return {
      kind: 'failure',
      retryable: true,
      error: { kind: 'UNAVAILABLE', reason: String(response.status) },
    };
  }
  if (response.status >= 400) {
    return {
      kind: 'failure',
      retryable: false,
      error: {
        kind: 'REJECTED',
        providerMessage: `HTTP ${response.status}`,
        afterTransientFailure: false,
      },
    };
  }
  return {
    kind: 'failure',
    retryable: false,
    error: { kind: 'INVALID_RESPONSE', reason: String(response.status) },
  };
}

/**
 * A thrown error (DNS failure, connection reset, TypeError from fetch) is not retried. The
 * Standard_Profile retries only timeouts and 5xx. Only the exception class name is recorded.
 */
function networkFailure(error: unknown): AttemptOutcome {
  const reason = error instanceof Error ? error.name : UNKNOWN_EXCEPTION_REASON;
  return {
    kind: 'failure',
    retryable: false,
    error: { kind: 'UNAVAILABLE', reason },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
