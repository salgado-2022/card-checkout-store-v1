import { errAsync, type Result, ResultAsync } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';

/**
 * Shared by the in-memory repositories: returns the injected failure when there is one, otherwise
 * the synchronous outcome of `compute`, wrapped in a ResultAsync.
 */
export function respond<T>(
  failure: RepositoryError | null,
  compute: () => Result<T, RepositoryError>,
): ResultAsync<T, RepositoryError> {
  if (failure) {
    return errAsync(failure);
  }
  return new ResultAsync(Promise.resolve(compute()));
}

export function notFound(entity: string): RepositoryError {
  return { kind: 'REPOSITORY_ERROR', reason: `${entity}NotFound` };
}
