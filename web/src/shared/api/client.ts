import { err, ok, Result, ResultAsync } from 'neverthrow';
import { getEnv } from './env';

// Used when VITE_API_BASE is not set. It matches the value the build sets in every environment.
const DEFAULT_API_BASE = '/api/v1';

export type ApiError =
  | { kind: 'http'; status: number; body: unknown }
  | { kind: 'invalid-json'; status: number }
  | { kind: 'network' };

export interface ApiRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

const toNetworkError = (): ApiError => ({ kind: 'network' });

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => 'not-json' as const,
);

// Maps a response to a Result. A 2xx body must be JSON. For a failed status, the body is the
// parsed JSON when possible and the raw text otherwise.
function toResult<T>(response: Response, text: string): Result<T, ApiError> {
  const parsed = parseJson(text);
  if (response.ok) {
    return parsed.match(
      (value) => ok(value as T),
      () => err({ kind: 'invalid-json', status: response.status }),
    );
  }
  return err({ kind: 'http', status: response.status, body: parsed.unwrapOr(text) });
}

// Sends a request below `VITE_API_BASE`. Failed statuses and network errors come back as `Err`;
// this function never throws for them. The generic `T` is the caller's assertion of the shape.
export function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): ResultAsync<T, ApiError> {
  const { method = 'GET', body, headers } = options;
  const url = `${getEnv('VITE_API_BASE') ?? DEFAULT_API_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  return ResultAsync.fromPromise(fetch(url, init), toNetworkError).andThen((response) =>
    ResultAsync.fromPromise(response.text(), toNetworkError).andThen((text) =>
      toResult<T>(response, text),
    ),
  );
}
