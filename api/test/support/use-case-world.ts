import { CreateTransaction } from '../../src/application/use-cases/create-transaction';
import { FinalizeTransaction } from '../../src/application/use-cases/finalize-transaction';
import { SyncTransactionStatus } from '../../src/application/use-cases/sync-transaction-status';
import { FakeApplicationLogger } from './fake-application-logger';
import { FakeClock } from './fake-clock';
import { FakeIdGenerator } from './fake-id-generator';
import { FakePaymentGateway } from './fake-payment-gateway';
import { InMemoryCustomerRepository } from './in-memory-customer-repository';
import { InMemoryDeliveryRepository } from './in-memory-delivery-repository';
import { InMemoryIdempotencyRepository } from './in-memory-idempotency-repository';
import { InMemoryProductRepository } from './in-memory-product-repository';
import { InMemoryTransactionRepository } from './in-memory-transaction-repository';
import { TRANSACTION_CUSTOMER, TRANSACTION_PRODUCT } from './transactions-http-app';

/** The real use cases over in-memory fakes, with no HTTP layer. */
export interface UseCaseWorld {
  readonly createTransaction: CreateTransaction;
  readonly syncTransactionStatus: SyncTransactionStatus;
  readonly clock: FakeClock;
  readonly products: InMemoryProductRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly transactions: InMemoryTransactionRepository;
  readonly gateway: FakePaymentGateway;
  readonly logger: FakeApplicationLogger;
}

export function createUseCaseWorld(): UseCaseWorld {
  const clock = new FakeClock('2026-05-01T10:00:00.000Z');
  const products = new InMemoryProductRepository([TRANSACTION_PRODUCT]);
  const customers = new InMemoryCustomerRepository([TRANSACTION_CUSTOMER]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  const idempotency = new InMemoryIdempotencyRepository(clock);
  const gateway = new FakePaymentGateway();
  const logger = new FakeApplicationLogger();
  const finalize = new FinalizeTransaction(transactions, logger, clock);
  const createTransaction = new CreateTransaction(
    idempotency,
    products,
    customers,
    transactions,
    deliveries,
    gateway,
    finalize,
    { baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 },
    new FakeIdGenerator(),
    clock,
    logger,
  );
  const syncTransactionStatus = new SyncTransactionStatus(
    transactions,
    gateway,
    finalize,
    logger,
    clock,
  );
  return {
    createTransaction,
    syncTransactionStatus,
    clock,
    products,
    deliveries,
    transactions,
    gateway,
    logger,
  };
}
