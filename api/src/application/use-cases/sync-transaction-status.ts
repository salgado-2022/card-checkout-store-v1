import { errAsync, okAsync, type ResultAsync } from 'neverthrow';
import type { Transaction } from '../../domain/entities';
import { isFinalStatus } from '../../domain/transaction-status';
import type { PaymentGatewayError, RepositoryError } from '../errors';
import type { ApplicationLogger } from '../ports/application-logger';
import type { Clock } from '../ports/clock';
import type {
  PaymentGateway,
  ProviderStatusReport,
  ReconciliationOutcome,
} from '../ports/payment-gateway';
import type { TransactionRepository } from '../ports/transaction-repository';
import { providerReason } from '../provider-reason';
import type { FinalizeTransaction } from './finalize-transaction';

/** Minimum age of the last provider sync before the provider is asked again (Requirement 9.3/9.4). */
export const MIN_SYNC_INTERVAL_MS = 1_000;
/** Reconciliation_Window: age of a Transaction without External_Id after which a missing record is final. */
export const RECONCILIATION_WINDOW_MS = 60_000;
export const PROVIDER_UNREACHABLE_REASON = 'PROVIDER_UNREACHABLE';

export type SyncTransactionStatusError =
  RepositoryError | { readonly kind: 'TRANSACTION_NOT_FOUND' };

type GatewayAttempt<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: PaymentGatewayError };

/**
 * Backs `GET /transactions/:id`. Makes at most one provider call per invocation (`getStatus` or
 * `findByReference`) and never creates a payment. Provider failures are absorbed: the stored
 * Transaction is returned and a warning is logged.
 */
export class SyncTransactionStatus {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly gateway: PaymentGateway,
    private readonly finalizeTransaction: FinalizeTransaction,
    private readonly logger: ApplicationLogger,
    private readonly clock: Clock,
  ) {}

  execute(id: string): ResultAsync<Transaction, SyncTransactionStatusError> {
    return this.transactions
      .findById(id)
      .andThen((transaction): ResultAsync<Transaction, SyncTransactionStatusError> =>
        transaction === null
          ? errAsync({ kind: 'TRANSACTION_NOT_FOUND' })
          : this.sync(transaction, this.clock.now()),
      );
  }

  private sync(transaction: Transaction, now: Date): ResultAsync<Transaction, RepositoryError> {
    if (transaction.status !== 'PENDING') {
      return okAsync(transaction);
    }
    if (transaction.externalId === undefined) {
      return this.reconcile(transaction, now);
    }
    return isSyncDue(transaction, now)
      ? this.syncKnown(transaction, transaction.externalId, now)
      : okAsync(transaction);
  }

  /** PENDING with an External_Id: ask the provider for the status. */
  private syncKnown(
    transaction: Transaction,
    externalId: string,
    now: Date,
  ): ResultAsync<Transaction, RepositoryError> {
    return this.gateway
      .getStatus(externalId)
      .map((value): GatewayAttempt<ProviderStatusReport> => ({ kind: 'answered', value }))
      .orElse((error) =>
        okAsync<GatewayAttempt<ProviderStatusReport>, never>({ kind: 'failed', error }),
      )
      .andThen((attempt) =>
        this.recordSync(transaction, now).andThen((synced) => {
          if (attempt.kind === 'failed') {
            this.warnGatewayFailure(
              'status request failed, transaction kept pending',
              synced,
              attempt.error,
            );
            return okAsync<Transaction, RepositoryError>(synced);
          }
          return this.applyReport(synced, attempt.value);
        }),
      );
  }

  /** PENDING without an External_Id: look the payment up by our Reference (never creates one). */
  private reconcile(
    transaction: Transaction,
    now: Date,
  ): ResultAsync<Transaction, RepositoryError> {
    return this.gateway
      .findByReference(transaction.reference)
      .map((value): GatewayAttempt<ReconciliationOutcome> => ({ kind: 'answered', value }))
      .orElse((error) =>
        okAsync<GatewayAttempt<ReconciliationOutcome>, never>({ kind: 'failed', error }),
      )
      .andThen((attempt): ResultAsync<Transaction, RepositoryError> => {
        if (attempt.kind === 'failed') {
          this.warnGatewayFailure(
            'reference lookup failed, transaction kept pending',
            transaction,
            attempt.error,
          );
          return okAsync(transaction);
        }
        const outcome = attempt.value;
        if (outcome.kind === 'not_found') {
          return this.applyNotFound(transaction, now);
        }
        return this.transactions
          .setExternalId(transaction.id, outcome.externalId)
          .andThen(() => this.recordSync({ ...transaction, externalId: outcome.externalId }, now))
          .andThen((synced) => this.applyReport(synced, outcome.status));
      });
  }

  /** No provider record: final only once the Reconciliation_Window has passed; no writes before that. */
  private applyNotFound(
    transaction: Transaction,
    now: Date,
  ): ResultAsync<Transaction, RepositoryError> {
    const age = now.getTime() - Date.parse(transaction.createdAt);
    if (Number.isNaN(age)) {
      this.logger.warn('unreadable createdAt', { reference: transaction.reference });
      return okAsync(transaction);
    }
    if (age < RECONCILIATION_WINDOW_MS) {
      return okAsync(transaction);
    }
    return this.finalizeTransaction.execute(transaction, {
      source: 'internal',
      status: 'ERROR',
      statusReason: PROVIDER_UNREACHABLE_REASON,
    });
  }
  /** Stores `lastSyncedAt` on a best-effort basis: a failed write is logged and the sync continues. */
  private recordSync(
    transaction: Transaction,
    now: Date,
  ): ResultAsync<Transaction, RepositoryError> {
    return this.transactions
      .setLastSynced(transaction.id, now)
      .map((): Transaction => ({ ...transaction, lastSyncedAt: now.toISOString() }))
      .orElse((error) => {
        this.logger.warn('could not store lastSyncedAt', {
          reference: transaction.reference,
          reason: error.reason,
        });
        return okAsync<Transaction, RepositoryError>(transaction);
      });
  }

  /** Finalizes on a final status (Amount_Check runs inside FinalizeTransaction); otherwise keeps PENDING. */
  private applyReport(
    transaction: Transaction,
    report: ProviderStatusReport,
  ): ResultAsync<Transaction, RepositoryError> {
    if (report.status === 'UNKNOWN') {
      this.logger.warn('provider reported an unknown status, transaction kept pending', {
        reference: transaction.reference,
      });
      return okAsync(transaction);
    }
    const status = report.status;
    if (!isFinalStatus(status)) {
      return okAsync(transaction);
    }
    const reason = status === 'APPROVED' ? undefined : providerReason(report.message);
    return this.finalizeTransaction.execute(transaction, {
      source: 'provider',
      status,
      ...(reason === undefined ? {} : { statusReason: reason }),
      report: {
        amountInCents: report.amountInCents,
        currency: report.currency,
        reference: report.reference,
      },
    });
  }

  /** Logs only the failure kind and the technical reason; the provider message is never logged. */
  private warnGatewayFailure(
    message: string,
    transaction: Transaction,
    error: PaymentGatewayError,
  ): void {
    this.logger.warn(message, {
      reference: transaction.reference,
      failure: error.kind,
      ...(error.kind === 'REJECTED' ? {} : { reason: error.reason }),
    });
  }
}

/** No previous sync, or the last one is at least 1 s old. An unreadable timestamp counts as old. */
function isSyncDue(transaction: Transaction, now: Date): boolean {
  if (transaction.lastSyncedAt === undefined) {
    return true;
  }
  const elapsed = now.getTime() - Date.parse(transaction.lastSyncedAt);
  return Number.isNaN(elapsed) || elapsed >= MIN_SYNC_INTERVAL_MS;
}
