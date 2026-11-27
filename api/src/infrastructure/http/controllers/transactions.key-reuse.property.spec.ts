import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import { createTransactionsHttpApp } from '../../../../test/support/transactions-http-app';
import {
  idempotencyKeyArbitrary,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  seedInProgressRecord,
  transactionBodyArbitrary,
  withOtherInstallments,
} from '../../../../test/support/transaction-property-helpers';
import { envelopeFor } from '../error-catalog';

// Feature: payments-api, Property 18: A different body under a reused key is rejected
describe('Feature: payments-api, Property 18: A different body under a reused key is rejected', () => {
  it(
    'answers 422 IDEMPOTENCY_KEY_REUSED and writes nothing when the key was completed or is in progress',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          fc.boolean(),
          async (key, body, completed) => {
            const testApp = await createTransactionsHttpApp();
            try {
              const different = withOtherInstallments(body);
              if (completed) {
                testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
                const first = await postTransaction(testApp, body, key);
                expect(first.status).toBe(201);
              } else {
                await seedInProgressRecord(testApp, key, body);
              }
              const transactionsBefore = testApp.transactions.count();
              const deliveriesBefore = testApp.deliveries.count();
              const callsBefore = testApp.gateway.callCount('create');

              const reused = await postTransaction(testApp, different, key);

              expect(reused.status).toBe(422);
              expect(reused.body).toEqual(envelopeFor('IDEMPOTENCY_KEY_REUSED'));
              expect(testApp.transactions.count()).toBe(transactionsBefore);
              expect(testApp.deliveries.count()).toBe(deliveriesBefore);
              expect(testApp.gateway.callCount('create')).toBe(callsBefore);
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
