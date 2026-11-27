import { errAsync, okAsync, type ResultAsync } from 'neverthrow';
import { checkAmount, type ReportedAmount } from '../../domain/amount-check';
import { canTransitionDelivery } from '../../domain/delivery-status';
import type { DeliveryStatus } from '../../domain/delivery-status';
import type { Transaction } from '../../domain/entities';
import { canTransitionTransaction, type FinalStatus } from '../../domain/transaction-status';
import type { RepositoryError } from '../errors';
import type { ApplicationLogger } from '../ports/application-logger';
import type { Clock } from '../ports/clock';
import type {
  FinalizeInput,
  FinalizeOutcome,
  TransactionRepository,
} from '../ports/transaction-repository';
export const AMOUNT_MISMATCH_REASON = 'AMOUNT_MISMATCH';
/**
 * A final status reported by the payment provider. `report` is mandatory, so the Amount_Check
 * cannot be skipped by forgetting it. `statusReason` is the provider text already reduced by
 * `providerReason`: it is stored but never logged.
 */
export interface ProviderFinalOutcome {
  readonly source: 'provider';
  readonly status: FinalStatus;
  readonly statusReason?: string;
  readonly report: ReportedAmount;
}

/**
 * A decision taken by this API (a provider rejection, `PROVIDER_UNREACHABLE`). It carries no
 * report, so there is nothing to compare, and it can only end the Transaction as ERROR.
 * `statusReason` is a short reason code chosen by the caller.
 */
export interface InternalFinalOutcome {
  readonly source: 'internal';
  readonly status: 'ERROR';
  readonly statusReason: string;
}

export type FinalStatusOutcome = ProviderFinalOutcome | InternalFinalOutcome;

/** The one place where a Transaction leaves PENDING, so every caller gets the Amount_Check. */
export class FinalizeTransaction {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly logger: ApplicationLogger,
    private readonly clock: Clock,
  ) {}
  execute(
    transaction: Transaction,
    outcome: FinalStatusOutcome,
  ): ResultAsync<Transaction, RepositoryError> {
    if (transaction.status !== 'PENDING') {
      return okAsync(transaction);
    }
    const resolved = this.resolve(transaction, outcome);
    const deliveryStatus: DeliveryStatus =
      resolved.status === 'APPROVED' ? 'ASSIGNED' : 'CANCELLED';
    if (
      !canTransitionTransaction(transaction.status, resolved.status) ||
      !canTransitionDelivery('PENDING', deliveryStatus)
    ) {
      return repositoryFailure('InvalidTransition');
    }
    const input: FinalizeInput = {
      transactionId: transaction.id,
      deliveryId: transaction.deliveryId,
      productId: transaction.productId,
      quantity: transaction.quantity,
      status: resolved.status,
      ...(resolved.statusReason === undefined ? {} : { statusReason: resolved.statusReason }),
      deliveryStatus: deliveryStatus as FinalizeInput['deliveryStatus'],
      at: this.clock.now().toISOString(),
    };
    return this.transactions
      .finalize(input)
      .andThen((result) => this.afterFirstAttempt(transaction, input, result));
  }
  /** Runs the Amount_Check when a report is present. A mismatch overrides any reported status. */
  private resolve(
    transaction: Transaction,
    outcome: FinalStatusOutcome,
  ): { status: FinalStatus; statusReason?: string } {
    const check =
      outcome.source === 'provider' ? checkAmount(outcome.report, transaction) : undefined;
    if (check?.kind === 'mismatch') {
      this.logger.alert('Amount check failed: reported values differ from the stored transaction', {
        reference: transaction.reference,
        // A string: the logger drops arrays.
        fields: check.fields.join(','),
      });
      return { status: 'ERROR', statusReason: AMOUNT_MISMATCH_REASON };
    }
    return {
      status: outcome.status,
      ...(outcome.statusReason === undefined ? {} : { statusReason: outcome.statusReason }),
    };
  }
  private afterFirstAttempt(
    transaction: Transaction,
    input: FinalizeInput,
    result: FinalizeOutcome,
  ): ResultAsync<Transaction, RepositoryError> {
    if (result.kind !== 'stock_unavailable') {
      return okAsync(result.transaction);
    }
    // The stock condition failed and nothing was written: approve the transaction without stock.
    return this.transactions
      .finalize({ ...input, deliveryStatus: 'BACKORDER' })
      .andThen((retry) => this.afterBackorder(transaction, retry));
  }
  private afterBackorder(
    transaction: Transaction,
    result: FinalizeOutcome,
  ): ResultAsync<Transaction, RepositoryError> {
    if (result.kind === 'stock_unavailable') {
      return repositoryFailure('UnexpectedStockCondition');
    }
    if (result.kind === 'applied') {
      this.logger.alert('Approved transaction has no stock: delivery set to BACKORDER', {
        reference: transaction.reference,
        productId: transaction.productId,
      });
    }
    return okAsync(result.transaction);
  }
}
function repositoryFailure(reason: string): ResultAsync<Transaction, RepositoryError> {
  return errAsync({ kind: 'REPOSITORY_ERROR', reason });
}
