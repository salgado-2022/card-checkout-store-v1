import type { ResultAsync } from 'neverthrow';
import type { Transaction } from '../../domain/entities';
import type { DeliveryStatus } from '../../domain/delivery-status';
import type { FinalStatus } from '../../domain/transaction-status';
import type { RepositoryError } from '../errors';

/** A Transaction is always created PENDING; the adapter sets `status` and `updatedAt`. */
export type NewTransaction = Omit<
  Transaction,
  'status' | 'statusReason' | 'externalId' | 'lastSyncedAt' | 'finalizedAt' | 'updatedAt'
>;

export interface FinalizeInput {
  readonly transactionId: string;
  readonly deliveryId: string;
  readonly productId: string;
  readonly quantity: number;
  /** Final status to store on the Transaction. */
  readonly status: FinalStatus;
  readonly statusReason?: string;
  /**
   * Target status of the Delivery. The product stock is decremented by `quantity`
   * (conditioned on `stock >= quantity`) if and only if this is `ASSIGNED`.
   */
  readonly deliveryStatus: Exclude<DeliveryStatus, 'PENDING'>;
  /** ISO-8601 instant used for `finalizedAt` and `updatedAt`. */
  readonly at: string;
}

/**
 * Result of the single TransactWriteItems issued by `finalize`:
 * - `applied`: every write succeeded; `transaction` is the stored state afterwards.
 * - `stock_unavailable`: the stock condition failed; nothing was written. The use case
 *   retries with `deliveryStatus: 'BACKORDER'` and emits an alert.
 * - `already_final`: the Transaction was no longer PENDING; nothing was written and
 *   `transaction` is the stored state.
 */
export type FinalizeOutcome =
  | { readonly kind: 'applied'; readonly transaction: Transaction }
  | { readonly kind: 'stock_unavailable' }
  | { readonly kind: 'already_final'; readonly transaction: Transaction };

export interface TransactionRepository {
  findById(id: string): ResultAsync<Transaction | null, RepositoryError>;
  /** Lookup through the `reference` GSI. */
  findByReference(reference: string): ResultAsync<Transaction | null, RepositoryError>;
  create(input: NewTransaction): ResultAsync<Transaction, RepositoryError>;
  setExternalId(id: string, externalId: string): ResultAsync<void, RepositoryError>;
  setLastSynced(id: string, at: Date): ResultAsync<void, RepositoryError>;
  /** Single TransactWriteItems (Transaction, Delivery and, when ASSIGNED, Product). */
  finalize(input: FinalizeInput): ResultAsync<FinalizeOutcome, RepositoryError>;
}
