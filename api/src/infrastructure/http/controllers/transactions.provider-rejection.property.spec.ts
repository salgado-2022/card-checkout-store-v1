import * as fc from 'fast-check';
import { err } from 'neverthrow';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  idempotencyKeyArbitrary,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerCodeArbitrary,
  transactionBodyArbitrary,
} from '../../../../test/support/transaction-property-helpers';
import type { PaymentGatewayError } from '../../../application/errors';
import { envelopeFor } from '../error-catalog';

/** The Transaction stored under `key`, read through the idempotency record that points at it. */
function storedTransactionOf(testApp: TransactionsHttpApp, key: string) {
  const transactionId = testApp.idempotency.get(key)?.transactionId ?? '';
  return testApp.transactions.get(transactionId);
}

/** Checks the state left by a request that ended PENDING without a provider External_Id. */
function expectPendingWithoutExternalId(
  testApp: TransactionsHttpApp,
  key: string,
  stockBefore: number,
): void {
  const stored = storedTransactionOf(testApp, key);
  expect(stored?.status).toBe('PENDING');
  expect(stored?.externalId).toBeUndefined();
  expect(testApp.deliveries.get(stored?.deliveryId ?? '')?.status).toBe('PENDING');
  expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(stockBefore);
  expect(testApp.gateway.callLog).toEqual(['create']);
  expect(testApp.gateway.callCount('findByReference')).toBe(0);
}

// Feature: payments-api, Property 25: A 4xx on the first attempt marks the transaction ERROR; a 4xx on the retry after an unreachable first attempt stays PENDING for later reconciliation
describe('Feature: payments-api, Property 25: A 4xx on the first attempt marks the transaction ERROR; a 4xx on the retry after an unreachable first attempt stays PENDING for later reconciliation', () => {
  it(
    'marks the transaction ERROR, cancels the Delivery and answers 502 after a clean first-attempt 4xx',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          providerCodeArbitrary,
          async (key, body, providerMessage) => {
            const testApp = await createTransactionsHttpApp();
            try {
              const rejection: PaymentGatewayError = {
                kind: 'REJECTED',
                providerMessage,
                afterTransientFailure: false,
              };
              testApp.gateway.script.create.enqueue(err(rejection));
              const stockBefore = testApp.products.stockOf(TRANSACTION_PRODUCT.id) ?? 0;

              const failed = await postTransaction(testApp, body, key);

              expect(failed.status).toBe(502);
              expect(failed.body).toEqual(envelopeFor('PAYMENT_PROVIDER_ERROR'));
              const stored = storedTransactionOf(testApp, key);
              expect(stored?.status).toBe('ERROR');
              expect(stored?.statusReason).toBe(providerMessage);
              expect(stored?.externalId).toBeUndefined();
              expect(testApp.deliveries.get(stored?.deliveryId ?? '')?.status).toBe('CANCELLED');
              expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(stockBefore);
              expect(testApp.gateway.callLog).toEqual(['create']);

              const replay = await postTransaction(testApp, body, key);

              expect(replay.status).toBe(502);
              expect(replay.body).toEqual(failed.body);
              expect(testApp.gateway.callCount('create')).toBe(1);
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
    'keeps the transaction PENDING without External_Id after an unreachable first attempt, whatever the retry answered',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          providerCodeArbitrary,
          fc.constantFrom<'retry_rejected' | 'timeout_or_5xx'>('retry_rejected', 'timeout_or_5xx'),
          async (key, body, providerMessage, scenario) => {
            const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
            try {
              const outcome: PaymentGatewayError =
                scenario === 'retry_rejected'
                  ? { kind: 'REJECTED', providerMessage, afterTransientFailure: true }
                  : { kind: 'UNAVAILABLE', reason: 'timeout_or_server_error' };
              testApp.gateway.script.create.enqueue(err(outcome));
              const stockBefore = testApp.products.stockOf(TRANSACTION_PRODUCT.id) ?? 0;

              const response = await postTransaction(testApp, body, key);

              expect(response.status).toBe(201);
              expect(response.body.status).toBe('PENDING');
              expectPendingWithoutExternalId(testApp, key, stockBefore);
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
