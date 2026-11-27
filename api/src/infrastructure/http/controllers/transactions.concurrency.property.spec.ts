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
} from '../../../../test/support/transaction-property-helpers';
import { envelopeFor } from '../error-catalog';

const FRESH_WINDOW_MS = 24_999;

// Feature: payments-api, Property 19: A concurrent identical request is rejected while in progress
describe('Feature: payments-api, Property 19: A concurrent identical request is rejected while in progress', () => {
  it(
    'answers 409 IDEMPOTENCY_KEY_IN_PROGRESS with zero gateway calls while the record is fresh',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          fc.integer({ min: 0, max: FRESH_WINDOW_MS }),
          async (key, body, elapsedMs) => {
            const testApp = await createTransactionsHttpApp();
            try {
              testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
              await seedInProgressRecord(testApp, key, body);
              testApp.clock.advance(elapsedMs);

              const response = await postTransaction(testApp, body, key);

              expect(response.status).toBe(409);
              expect(response.body).toEqual(envelopeFor('IDEMPOTENCY_KEY_IN_PROGRESS'));
              expect(testApp.gateway.callLog).toEqual([]);
              expect(testApp.transactions.count()).toBe(0);
              expect(testApp.deliveries.count()).toBe(0);
              expect(testApp.idempotency.get(key)?.state).toBe('IN_PROGRESS');
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
