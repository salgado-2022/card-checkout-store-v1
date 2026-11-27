import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';
import {
  idempotencyKeyArbitrary,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  providerStatusArbitrary,
  transactionBodyArbitrary,
} from '../../../../test/support/transaction-property-helpers';

// Feature: payments-api, Property 17: Idempotent replay produces exactly one transaction and one Provider call
describe('Feature: payments-api, Property 17: Idempotent replay produces exactly one transaction and one Provider call', () => {
  it(
    'answers the second request with the first body as 200 and never charges twice',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          providerStatusArbitrary,
          async (key, body, status) => {
            const testApp = await createTransactionsHttpApp();
            try {
              testApp.gateway.script.create.always(ok(providerAnswer(status, body.quantity)));
              const first = await postTransaction(testApp, body, key);
              const second = await postTransaction(testApp, body, key);

              expect(first.status).toBe(201);
              expect(second.status).toBe(200);
              expect(second.body).toEqual(first.body);
              expect(testApp.gateway.callCount('create')).toBe(1);
              expect(testApp.transactions.count()).toBe(1);
              expect(testApp.deliveries.count()).toBe(1);
              const approvedUnits = status === 'APPROVED' ? body.quantity : 0;
              expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(
                TRANSACTION_PRODUCT.stock - approvedUnits,
              );
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
