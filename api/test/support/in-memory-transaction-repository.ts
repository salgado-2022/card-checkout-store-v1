import { err, ok, type Result } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';
import type {
  FinalizeInput,
  FinalizeOutcome,
  NewTransaction,
  TransactionRepository,
} from '../../src/application/ports/transaction-repository';
import type { Transaction } from '../../src/domain/entities';
import type { InMemoryDeliveryRepository } from './in-memory-delivery-repository';
import type { InMemoryProductRepository } from './in-memory-product-repository';
import { notFound, respond } from './repository-result';

export class InMemoryTransactionRepository implements TransactionRepository {
  failure: RepositoryError | null = null;
  /** Number of `finalize` calls that wrote something; lets tests assert "no second write". */
  appliedFinalizations = 0;
  private readonly transactions = new Map<string, Transaction>();

  /** `finalize` writes the stock and the delivery, so the fake shares those two repositories. */
  constructor(
    private readonly products: InMemoryProductRepository,
    private readonly deliveries: InMemoryDeliveryRepository,
  ) {}

  findById(id: string) {
    return respond(this.failure, () => ok(this.transactions.get(id) ?? null));
  }

  findByReference(reference: string) {
    return respond(this.failure, () =>
      ok([...this.transactions.values()].find((t) => t.reference === reference) ?? null),
    );
  }

  create(input: NewTransaction) {
    return respond(this.failure, () => {
      const transaction: Transaction = { ...input, status: 'PENDING', updatedAt: input.createdAt };
      this.transactions.set(transaction.id, transaction);
      return ok(transaction);
    });
  }

  setExternalId(id: string, externalId: string) {
    return respond(this.failure, () => this.patch(id, { externalId }));
  }

  setLastSynced(id: string, at: Date) {
    return respond(this.failure, () => this.patch(id, { lastSyncedAt: at.toISOString() }));
  }

  finalize(input: FinalizeInput) {
    return respond(this.failure, () => this.finalizeNow(input));
  }

  count(): number {
    return this.transactions.size;
  }

  /** Same as `findById` but as a plain value, for assertions. */
  get(id: string): Transaction | undefined {
    return this.transactions.get(id);
  }

  private patch(id: string, fields: Partial<Transaction>): Result<void, RepositoryError> {
    const current = this.transactions.get(id);
    if (!current) {
      return err(notFound('Transaction'));
    }
    this.transactions.set(id, { ...current, ...fields });
    return ok(undefined);
  }

  /** All-or-nothing, like the single TransactWriteItems: every condition is checked before any write. */
  private finalizeNow(input: FinalizeInput): Result<FinalizeOutcome, RepositoryError> {
    const current = this.transactions.get(input.transactionId);
    if (!current) {
      return err(notFound('Transaction'));
    }
    if (current.status !== 'PENDING') {
      return ok({ kind: 'already_final', transaction: current });
    }
    const decrementsStock = input.deliveryStatus === 'ASSIGNED';
    if (decrementsStock && !this.products.hasStockFor(input.productId, input.quantity)) {
      return ok({ kind: 'stock_unavailable' });
    }
    if (!this.deliveries.updateStatus(input.deliveryId, input.deliveryStatus, input.at)) {
      return err(notFound('Delivery'));
    }
    if (decrementsStock) {
      this.products.decrementIfAvailable(input.productId, input.quantity);
    }
    const updated: Transaction = {
      ...current,
      status: input.status,
      ...(input.statusReason === undefined ? {} : { statusReason: input.statusReason }),
      finalizedAt: input.at,
      updatedAt: input.at,
    };
    this.transactions.set(updated.id, updated);
    this.appliedFinalizations += 1;
    return ok({ kind: 'applied', transaction: updated });
  }
}
