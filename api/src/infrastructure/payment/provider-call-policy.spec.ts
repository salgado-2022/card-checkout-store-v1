import type { Result } from 'neverthrow';
import type { PaymentGatewayError } from '../../application/errors';
import {
  MAX_BODY_BYTES,
  STANDARD_PROFILE_TIMING,
  SINGLE_ATTEMPT_PROFILE_TIMING,
  withSingleAttemptProfile,
  withStandardProfile,
  type ProviderAttempt,
} from './provider-call-policy';

const response = (status: number): Response => new Response(null, { status });

/** A provider call that never settles and ignores its signal, like a stalled socket. */
const stalled = (): Promise<Response> => new Promise<Response>(() => undefined);

/** Settles with the given responses in order; the attempt mock records each call. */
function scripted(
  ...steps: Array<Response | Error | 'hang'>
): jest.Mock<Promise<Response>, [AbortSignal]> {
  const attempt = jest.fn<Promise<Response>, [AbortSignal]>();
  for (const step of steps) {
    if (step === 'hang') attempt.mockImplementationOnce(stalled);
    else if (step instanceof Error) attempt.mockRejectedValueOnce(step);
    else attempt.mockResolvedValueOnce(step);
  }
  return attempt;
}

function unwrapErr(result: Result<Response, PaymentGatewayError>): PaymentGatewayError {
  return result._unsafeUnwrapErr();
}

describe('withStandardProfile', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the first response when the first attempt succeeds, without a timer left behind', async () => {
    const attempt = scripted(response(201));

    const result = await withStandardProfile(attempt);

    expect(result._unsafeUnwrap().status).toBe(201);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries once after 5xx and returns the success of the retry', async () => {
    const attempt = scripted(response(503), response(200));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result._unsafeUnwrap().status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries once after a timeout and returns the success of the retry', async () => {
    const attempt = scripted('hang', response(200));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result._unsafeUnwrap().status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives UNAVAILABLE after two 5xx answers and makes no third attempt', async () => {
    const attempt = scripted(response(500), response(502), response(200));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: '502' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives UNAVAILABLE after two timeouts and makes no third attempt', async () => {
    const attempt = scripted('hang', 'hang', response(200));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'AbortError' });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not retry a 4xx and reports REJECTED without afterTransientFailure', async () => {
    const attempt = scripted(response(422), response(200));

    const result = await withStandardProfile(attempt);

    expect(unwrapErr(result)).toEqual({
      kind: 'REJECTED',
      providerMessage: 'HTTP 422',
      afterTransientFailure: false,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reports REJECTED with afterTransientFailure true when a 4xx answers the retry after 5xx', async () => {
    const attempt = scripted(response(500), response(400));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(unwrapErr(result)).toEqual({
      kind: 'REJECTED',
      providerMessage: 'HTTP 400',
      afterTransientFailure: true,
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('reports REJECTED with afterTransientFailure true when a 4xx answers the retry after a timeout', async () => {
    const attempt = scripted('hang', response(409));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(unwrapErr(result)).toMatchObject({ kind: 'REJECTED', afterTransientFailure: true });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry a network error and records only the exception class name', async () => {
    const attempt = scripted(
      new TypeError('fetch failed: socket hang up at https://secret.example'),
    );

    const result = await withStandardProfile(attempt);

    const error = unwrapErr(result);
    expect(error).toEqual({ kind: 'UNAVAILABLE', reason: 'TypeError' });
    expect(JSON.stringify(error)).not.toContain('secret.example');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives UNAVAILABLE when the retry after 5xx fails with a network error', async () => {
    const attempt = scripted(response(503), new TypeError('reset'));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'TypeError' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('records UnknownError when a non-Error value is thrown', async () => {
    const attempt = jest.fn<Promise<Response>, [AbortSignal]>(() => {
      throw 'plain string';
    });

    const result = await withStandardProfile(attempt);

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'UnknownError' });
  });

  it('reports INVALID_RESPONSE for a status that is neither success, 4xx nor 5xx', async () => {
    const attempt = scripted(response(302));

    const result = await withStandardProfile(attempt);

    expect(unwrapErr(result)).toEqual({ kind: 'INVALID_RESPONSE', reason: '302' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('aborts the signal passed to the attempt when the timeout fires', async () => {
    let seenSignal: AbortSignal | undefined;
    const attempt: ProviderAttempt = (signal) => {
      seenSignal = signal;
      return stalled();
    };

    const pending = withStandardProfile(attempt, { attemptTimeoutMs: 100, backoffMs: 0 });
    await jest.runAllTimersAsync();
    await pending;

    expect(seenSignal?.aborted).toBe(true);
  });

  it('uses the 10 s attempt timeout and the 500 ms backoff by default', async () => {
    expect(STANDARD_PROFILE_TIMING).toEqual({ attemptTimeoutMs: 10_000, backoffMs: 500 });
    const attempt = scripted('hang', response(200));

    const pending = withStandardProfile(attempt);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(499);
    expect(attempt).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('accepts injected timing for the attempt timeout and the backoff', async () => {
    const attempt = scripted(response(500), response(200));

    const pending = withStandardProfile(attempt, { attemptTimeoutMs: 100, backoffMs: 50 });
    await jest.advanceTimersByTimeAsync(49);
    expect(attempt).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect((await pending)._unsafeUnwrap().status).toBe(200);
  });
});

describe('provider body handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Headers arrive at once, but the body stream never ends (a slow or stalled body). */
  const slowBody = (): Response =>
    new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 });

  it('times out when the headers arrive but the body never finishes', async () => {
    const attempt = scripted(slowBody());

    const pending = withSingleAttemptProfile(attempt);
    await jest.advanceTimersByTimeAsync(SINGLE_ATTEMPT_PROFILE_TIMING.attemptTimeoutMs);
    const result = await pending;

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'AbortError' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries once under the Standard_Profile when the first body stalls', async () => {
    const attempt = scripted(slowBody(), new Response('{"ok":true}', { status: 200 }));

    const pending = withStandardProfile(attempt);
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(await result._unsafeUnwrap().json()).toEqual({ ok: true });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('returns a response whose body the caller can still read as JSON', async () => {
    const attempt = scripted(
      new Response('{"data":{"id":"x"}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await withSingleAttemptProfile(attempt);
    const buffered = result._unsafeUnwrap();

    expect(buffered.status).toBe(200);
    expect(buffered.headers.get('content-type')).toBe('application/json');
    expect(await buffered.json()).toEqual({ data: { id: 'x' } });
  });

  it('keeps a 204 response without a body', async () => {
    const result = await withSingleAttemptProfile(scripted(response(204)));

    expect(result._unsafeUnwrap().status).toBe(204);
  });

  it('rejects a declared Content-Length above the limit without reading the body', async () => {
    const big = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    });

    const result = await withStandardProfile(scripted(big));

    expect(unwrapErr(result)).toEqual({ kind: 'INVALID_RESPONSE', reason: 'BodyTooLarge' });
  });

  it('rejects a body above the limit when no Content-Length is declared, without retrying', async () => {
    const attempt = scripted(new Response('x'.repeat(MAX_BODY_BYTES + 1), { status: 200 }));

    const result = await withStandardProfile(attempt);

    expect(unwrapErr(result)).toEqual({ kind: 'INVALID_RESPONSE', reason: 'BodyTooLarge' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reports UNAVAILABLE with the class name when reading the body fails', async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.error(new TypeError('socket reset secret-detail')),
      }),
      { status: 200 },
    );

    const result = await withSingleAttemptProfile(scripted(broken));

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'TypeError' });
  });
});

describe('withSingleAttemptProfile', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the response of its only attempt', async () => {
    const attempt = scripted(response(200));

    const result = await withSingleAttemptProfile(attempt);

    expect(result._unsafeUnwrap().status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives UNAVAILABLE at 3 s on timeout and never sends a second attempt', async () => {
    const attempt = scripted('hang', response(200));

    const pending = withSingleAttemptProfile(attempt);
    await jest.advanceTimersByTimeAsync(2_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const result = await pending;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'AbortError' });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('makes exactly one attempt on 5xx and reports UNAVAILABLE', async () => {
    const attempt = scripted(response(503), response(200));

    const result = await withSingleAttemptProfile(attempt);
    await jest.runAllTimersAsync();

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: '503' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one attempt on 4xx and reports REJECTED without afterTransientFailure', async () => {
    const attempt = scripted(response(404), response(200));

    const result = await withSingleAttemptProfile(attempt);

    expect(unwrapErr(result)).toEqual({
      kind: 'REJECTED',
      providerMessage: 'HTTP 404',
      afterTransientFailure: false,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one attempt on a network error and reports UNAVAILABLE', async () => {
    const attempt = scripted(new TypeError('offline'));

    const result = await withSingleAttemptProfile(attempt);

    expect(unwrapErr(result)).toEqual({ kind: 'UNAVAILABLE', reason: 'TypeError' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('uses the 3 s timeout by default', async () => {
    expect(SINGLE_ATTEMPT_PROFILE_TIMING).toEqual({ attemptTimeoutMs: 3_000 });
    const attempt = scripted('hang');

    const pending = withSingleAttemptProfile(attempt);
    await jest.advanceTimersByTimeAsync(3_000);

    expect(unwrapErr(await pending)).toEqual({ kind: 'UNAVAILABLE', reason: 'AbortError' });
  });
});
