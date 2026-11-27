import type { ResultAsync } from 'neverthrow';
import type { RepositoryError } from '../errors';

/**
 * Outcome of `begin`, one variant per branch of Requirement 6. "Fresh" versus "stale" is decided
 * by the adapter comparing the record age with the Lambda timeout using the injected `Clock`.
 */
export type BeginOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'hash_mismatch' }
  | { readonly kind: 'in_progress_fresh' }
  | {
      readonly kind: 'in_progress_stale';
      readonly transactionId: string | null;
      /** ISO-8601 creation instant of the stale record; pass it to `takeOver` as `previousCreatedAt`. */
      readonly createdAt: string;
    }
  | { readonly kind: 'completed'; readonly statusCode: number; readonly body: unknown };

export interface IdempotencyRepository {
  begin(key: string, requestHash: string, now: Date): ResultAsync<BeginOutcome, RepositoryError>;
  attachTransactionId(key: string, transactionId: string): ResultAsync<void, RepositoryError>;
  complete(key: string, statusCode: number, body: unknown): ResultAsync<void, RepositoryError>;
  /** Deletes the record so the key can be reused (Requirement 6.11). */
  release(key: string): ResultAsync<void, RepositoryError>;
  /** Takes over a stale record without a transaction id (Requirement 6.10). */
  takeOver(
    key: string,
    previousCreatedAt: string,
  ): ResultAsync<'taken' | 'lost_race', RepositoryError>;
}
