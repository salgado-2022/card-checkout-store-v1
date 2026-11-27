import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Customer, Product } from '../../src/domain/entities';
import { CreateTransaction } from '../../src/application/use-cases/create-transaction';
import { FinalizeTransaction } from '../../src/application/use-cases/finalize-transaction';
import { TransactionsController } from '../../src/infrastructure/http/controllers/transactions.controller';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import { createValidationPipe } from '../../src/infrastructure/http/validation-pipe';
import { FakeApplicationLogger } from './fake-application-logger';
import { FakeClock } from './fake-clock';
import { FakeIdGenerator } from './fake-id-generator';
import { FakePaymentGateway } from './fake-payment-gateway';
import { InMemoryCustomerRepository } from './in-memory-customer-repository';
import { InMemoryDeliveryRepository } from './in-memory-delivery-repository';
import { InMemoryIdempotencyRepository } from './in-memory-idempotency-repository';
import { InMemoryProductRepository } from './in-memory-product-repository';
import { InMemoryTransactionRepository } from './in-memory-transaction-repository';

export const TRANSACTION_PRODUCT: Product = {
  id: 'prod-1',
  sku: 'SKU-1',
  name: 'Product',
  description: 'Description',
  imageUrl: 'https://cdn.example/p.webp',
  priceInCents: 12_000_000,
  currency: 'COP',
  stock: 10,
};

export const TRANSACTION_CUSTOMER: Customer = {
  id: 'cust-1',
  email: 'ana@example.com',
  fullName: 'Ana Perez',
  phone: '3001234567',
  documentType: 'CC',
  documentNumber: '1234567890',
  createdAt: '2026-04-01T10:00:00.000Z',
  updatedAt: '2026-04-01T10:00:00.000Z',
};

const silentLogger = { warn: (): void => undefined, error: (): void => undefined };

export interface TransactionsHttpAppOptions {
  readonly products?: readonly Product[];
  readonly clock?: FakeClock;
}

/** The app under test plus the fakes behind it, so tests can seed and inspect state. */
export interface TransactionsHttpApp {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly products: InMemoryProductRepository;
  readonly customers: InMemoryCustomerRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly transactions: InMemoryTransactionRepository;
  readonly idempotency: InMemoryIdempotencyRepository;
  readonly gateway: FakePaymentGateway;
}

// Builds the transactions controller with the real use cases over in-memory fakes. Only the
// persistence, gateway, clock, id and logger ports are replaced. The global prefix, validation pipe
// and exception filter match the bootstrap in create-app.ts.
export async function createTransactionsHttpApp(
  options: TransactionsHttpAppOptions = {},
): Promise<TransactionsHttpApp> {
  const clock = options.clock ?? new FakeClock('2026-05-01T10:00:00.000Z');
  const products = new InMemoryProductRepository(options.products ?? [TRANSACTION_PRODUCT]);
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
  const moduleRef = await Test.createTestingModule({
    controllers: [TransactionsController],
    providers: [{ provide: CreateTransaction, useValue: createTransaction }],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(silentLogger));
  await app.init();
  return { app, clock, products, customers, deliveries, transactions, idempotency, gateway };
}
