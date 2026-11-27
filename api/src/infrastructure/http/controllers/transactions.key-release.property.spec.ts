import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  FIXED_KEY,
  idempotencyKeyArbitrary,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  transactionBodyArbitrary,
  type TransactionBody,
} from '../../../../test/support/transaction-property-helpers';
import { envelopeFor, type ErrorCode } from '../error-catalog';

const LOW_STOCK_PRODUCT_ID = 'prod-low';
const MISSING_PRODUCT_ID = 'prod-missing';
const MISSING_CUSTOMER_ID = 'cust-missing';
const LOW_STOCK_UNITS = 1;

interface PreWriteFailure {
  readonly name: string;
  readonly failing: (body: TransactionBody) => TransactionBody;
  readonly code: ErrorCode;
  readonly status: number;
}

// Each failure happens before the PENDING Transaction exists, so the key must become reusable.
const PRE_WRITE_FAILURES: readonly PreWriteFailure[] = [
  {
    name: 'unknown product',
    failing: (body) => ({ ...body, productId: MISSING_PRODUCT_ID }),
    code: 'PRODUCT_NOT_FOUND',
    status: 404,
  },
  {
    name: 'unknown customer',
    failing: (body) => ({ ...body, customerId: MISSING_CUSTOMER_ID }),
    code: 'CUSTOMER_NOT_FOUND',
    status: 404,
  },
  {
    name: 'insufficient stock',
    failing: (body) => ({
      ...body,
      productId: LOW_STOCK_PRODUCT_ID,
      quantity: Math.max(2, body.quantity),
    }),
    code: 'INSUFFICIENT_STOCK',
    status: 409,
  },
];

function appWithLowStockProduct(): Promise<TransactionsHttpApp> {
  return createTransactionsHttpApp({
    products: [
      TRANSACTION_PRODUCT,
      { ...TRANSACTION_PRODUCT, id: LOW_STOCK_PRODUCT_ID, stock: LOW_STOCK_UNITS },
    ],
  });
}

// Feature: payments-api, Property 21: Pre-write failures leave the idempotency key reusable
describe('Feature: payments-api, Property 21: Pre-write failures leave the idempotency key reusable', () => {
  it(
    'releases the record on a business error before the Transaction and processes the next request as new',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          fc.constantFrom(...PRE_WRITE_FAILURES),
          async (key, body, failure) => {
            const testApp = await appWithLowStockProduct();
            try {
              testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));

              const failed = await postTransaction(testApp, failure.failing(body), key);

              expect(failed.status).toBe(failure.status);
              expect(failed.body).toMatchObject({ statusCode: failure.status, code: failure.code });
              expect(testApp.idempotency.get(key)).toBeUndefined();
              expect(testApp.transactions.count()).toBe(0);
              expect(testApp.deliveries.count()).toBe(0);
              expect(testApp.gateway.callLog).toEqual([]);

              const retried = await postTransaction(testApp, body, key);

              expect(retried.status).toBe(201);
              expect(testApp.gateway.callCount('create')).toBe(1);
              expect(testApp.transactions.count()).toBe(1);
              expect(testApp.idempotency.get(key)?.state).toBe('COMPLETED');
            } finally {
              await testApp.app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'keeps the record after the Delivery is written, so the same key stays in progress',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          transactionBodyArbitrary,
          fc.integer({ min: 0, max: 24_999 }),
          async (body, elapsedMs) => {
            const testApp = await createTransactionsHttpApp();
            try {
              testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
              testApp.transactions.failure = {
                kind: 'REPOSITORY_ERROR',
                reason: 'TransactionWriteFailed',
              };

              const failed = await postTransaction(testApp, body, FIXED_KEY);

              expect(failed.status).toBe(500);
              expect(testApp.deliveries.count()).toBe(1);
              expect(testApp.transactions.count()).toBe(0);
              expect(testApp.idempotency.get(FIXED_KEY)?.state).toBe('IN_PROGRESS');
              expect(testApp.gateway.callLog).toEqual([]);

              testApp.transactions.failure = null;
              testApp.clock.advance(elapsedMs);
              const retried = await postTransaction(testApp, body, FIXED_KEY);

              expect(retried.status).toBe(409);
              expect(retried.body).toEqual(envelopeFor('IDEMPOTENCY_KEY_IN_PROGRESS'));
              expect(testApp.gateway.callLog).toEqual([]);
              expect(testApp.deliveries.count()).toBe(1);
            } finally {
              await testApp.app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
