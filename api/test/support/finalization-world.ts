import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { AwsClientStub } from 'aws-sdk-client-mock';
import { FinalizeTransaction } from '../../src/application/use-cases/finalize-transaction';
import type { TransactionRepository } from '../../src/application/ports/transaction-repository';
import type { DeliveryStatus } from '../../src/domain/delivery-status';
import type { Transaction } from '../../src/domain/entities';
import { DynamoTransactionRepository } from '../../src/infrastructure/persistence/transaction.repository.dynamodb';
import { FakeApplicationLogger } from './fake-application-logger';
import { FakeClock } from './fake-clock';
import { InMemoryDeliveryRepository } from './in-memory-delivery-repository';
import { InMemoryProductRepository } from './in-memory-product-repository';
import { InMemoryTransactionRepository } from './in-memory-transaction-repository';
import { TRANSACTION_PRODUCT } from './transactions-http-app';

export const WORLD_PRODUCT_ID = TRANSACTION_PRODUCT.id;
export const WORLD_CREATED_AT = '2026-05-01T10:00:00.000Z';
const UNIT_PRICE_IN_CENTS = 1_000_000;
const BASE_FEE_IN_CENTS = 300_000;
const DELIVERY_FEE_IN_CENTS = 800_000;

/** One PENDING Transaction (and its PENDING Delivery) to store before finalizing. */
export interface SeedSpec {
  /** Distinguishes ids and Reference when several transactions share one product. */
  readonly index: number;
  readonly quantity: number;
}

export interface WorldSnapshot {
  readonly transaction: Transaction;
  readonly deliveryStatus: DeliveryStatus;
  readonly stock: number;
}

/** A finalization setup over some persistence backend: the real use case on top of it. */
export interface FinalizationWorld {
  readonly repository: TransactionRepository;
  readonly finalize: FinalizeTransaction;
  readonly logger: FakeApplicationLogger;
  readonly clock: FakeClock;
  /** Stores a PENDING Transaction and Delivery and returns the Transaction. */
  seed(spec: SeedSpec): Transaction;
  snapshot(transaction: Transaction): WorldSnapshot;
  stock(): number;
  /** Number of `finalize` calls that wrote something. */
  writes(): number;
}

export function pendingTransaction(spec: SeedSpec): Transaction {
  const subtotalInCents = UNIT_PRICE_IN_CENTS * spec.quantity;
  return {
    id: `txn-${spec.index}`,
    reference: `ORD-TEST${spec.index}`,
    status: 'PENDING',
    productId: WORLD_PRODUCT_ID,
    quantity: spec.quantity,
    customerId: 'cust-1',
    deliveryId: `del-${spec.index}`,
    unitPriceInCents: UNIT_PRICE_IN_CENTS,
    subtotalInCents,
    baseFeeInCents: BASE_FEE_IN_CENTS,
    deliveryFeeInCents: DELIVERY_FEE_IN_CENTS,
    totalInCents: subtotalInCents + BASE_FEE_IN_CENTS + DELIVERY_FEE_IN_CENTS,
    currency: 'COP',
    installments: 1,
    cardBrand: 'VISA',
    cardLastFour: '4242',
    createdAt: WORLD_CREATED_AT,
    updatedAt: WORLD_CREATED_AT,
  };
}

function assemble(
  repository: TransactionRepository,
  extra: Pick<FinalizationWorld, 'seed' | 'snapshot' | 'stock' | 'writes'>,
): FinalizationWorld {
  const logger = new FakeApplicationLogger();
  const clock = new FakeClock('2026-05-01T10:05:00.000Z');
  return {
    repository,
    finalize: new FinalizeTransaction(repository, logger, clock),
    logger,
    clock,
    ...extra,
  };
}

/** In-memory repositories with the conditional `finalize` semantics of the real adapter. */
export function createInMemoryWorld(stock: number): FinalizationWorld {
  const products = new InMemoryProductRepository([{ ...TRANSACTION_PRODUCT, stock }]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  return assemble(transactions, {
    seed(spec) {
      const transaction = pendingTransaction(spec);
      void deliveries.create({
        id: transaction.deliveryId,
        transactionId: transaction.id,
        productId: transaction.productId,
        quantity: transaction.quantity,
        recipientName: 'Ana Perez',
        phone: '3001234567',
        addressLine1: 'Calle 1 2 3',
        city: 'Bogotá',
        department: 'Bogotá D.C.',
        createdAt: WORLD_CREATED_AT,
      });
      const { id, reference, productId, quantity, customerId, deliveryId } = transaction;
      void transactions.create({
        id,
        reference,
        productId,
        quantity,
        customerId,
        deliveryId,
        unitPriceInCents: transaction.unitPriceInCents,
        subtotalInCents: transaction.subtotalInCents,
        baseFeeInCents: transaction.baseFeeInCents,
        deliveryFeeInCents: transaction.deliveryFeeInCents,
        totalInCents: transaction.totalInCents,
        currency: transaction.currency,
        installments: transaction.installments,
        cardBrand: transaction.cardBrand,
        cardLastFour: transaction.cardLastFour,
        createdAt: WORLD_CREATED_AT,
      });
      return transaction;
    },
    snapshot: (transaction) => ({
      transaction: transactions.get(transaction.id) ?? transaction,
      deliveryStatus: deliveries.get(transaction.deliveryId)?.status ?? 'PENDING',
      stock: products.stockOf(WORLD_PRODUCT_ID) ?? Number.NaN,
    }),
    stock: () => products.stockOf(WORLD_PRODUCT_ID) ?? Number.NaN,
    writes: () => transactions.appliedFinalizations,
  });
}

const TRANSACTIONS_TABLE = 'test-transactions';
const DELIVERIES_TABLE = 'test-deliveries';
const PRODUCTS_TABLE = 'test-products';

type TransactItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

/**
 * The real `DynamoTransactionRepository` over a stateful stand-in for DynamoDB (an
 * `aws-sdk-client-mock` stub). It answers `GetCommand` from its state and evaluates the three
 * conditions of the finalization `TransactWriteCommand` all together before writing anything,
 * like DynamoDB does. Resets the stub, so one world is active at a time.
 */
export function createDynamoWorld(
  stub: AwsClientStub<DynamoDBDocumentClient>,
  stock: number,
): FinalizationWorld {
  const storedTransactions = new Map<string, Transaction>();
  const deliveryStatuses = new Map<string, DeliveryStatus>();
  const stocks = new Map<string, number>([[WORLD_PRODUCT_ID, stock]]);
  let writes = 0;
  stub.reset();
  stub.on(GetCommand).callsFake((input: { Key: { id: string } }) => ({
    Item: storedTransactions.get(input.Key.id),
  }));
  stub.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
    const items: TransactItems = input.TransactItems ?? [];
    const [transactionUpdate, deliveryUpdate, productUpdate] = items.map((item) => item.Update);
    const transactionId = transactionUpdate?.Key?.id as string;
    const deliveryId = deliveryUpdate?.Key?.id as string;
    const current = storedTransactions.get(transactionId);
    const quantity = productUpdate?.ExpressionAttributeValues?.[':quantity'] as number | undefined;
    const failures = [
      current?.status !== 'PENDING',
      deliveryStatuses.get(deliveryId) !== 'PENDING',
      ...(quantity === undefined ? [] : [(stocks.get(WORLD_PRODUCT_ID) ?? 0) < quantity]),
    ];
    if (failures.some(Boolean)) {
      throw new TransactionCanceledException({
        message: 'transaction cancelled',
        $metadata: {},
        CancellationReasons: failures.map((failed) => ({
          Code: failed ? 'ConditionalCheckFailed' : 'None',
        })),
      });
    }
    const values = transactionUpdate?.ExpressionAttributeValues ?? {};
    storedTransactions.set(transactionId, {
      ...(current as Transaction),
      status: values[':status'] as Transaction['status'],
      ...(values[':reason'] === undefined ? {} : { statusReason: values[':reason'] as string }),
      finalizedAt: values[':at'] as string,
      updatedAt: values[':at'] as string,
    });
    deliveryStatuses.set(
      deliveryId,
      deliveryUpdate?.ExpressionAttributeValues?.[':status'] as DeliveryStatus,
    );
    if (quantity !== undefined) {
      stocks.set(WORLD_PRODUCT_ID, (stocks.get(WORLD_PRODUCT_ID) ?? 0) - quantity);
    }
    writes += 1;
    return {};
  });
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const repository = new DynamoTransactionRepository(client, TRANSACTIONS_TABLE, {
    deliveries: DELIVERIES_TABLE,
    products: PRODUCTS_TABLE,
  });
  return assemble(repository, {
    seed(spec) {
      const transaction = pendingTransaction(spec);
      storedTransactions.set(transaction.id, transaction);
      deliveryStatuses.set(transaction.deliveryId, 'PENDING');
      return transaction;
    },
    snapshot: (transaction) => ({
      transaction: storedTransactions.get(transaction.id) ?? transaction,
      deliveryStatus: deliveryStatuses.get(transaction.deliveryId) ?? 'PENDING',
      stock: stocks.get(WORLD_PRODUCT_ID) ?? Number.NaN,
    }),
    stock: () => stocks.get(WORLD_PRODUCT_ID) ?? Number.NaN,
    writes: () => writes,
  });
}
