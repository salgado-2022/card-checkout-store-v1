import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import { createTransactionsHttpApp } from '../../../../test/support/transactions-http-app';
import {
  idempotencyKeyArbitrary,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  transactionBodyArbitrary,
} from '../../../../test/support/transaction-property-helpers';
import {
  createPendingWithoutExternalId,
  getTransactionRequest,
  lookupResult,
  lookupScenarioArbitrary,
  matchingStatus,
  unreachableCreateFailureArbitrary,
} from '../../../../test/support/reconciliation-helpers';

// Feature: payments-api, Property 26: An unreachable Provider never produces a second charge for the same reference
describe('Feature: payments-api, Property 26: An unreachable Provider never produces a second charge for the same reference', () => {
  it(
    'invokes PaymentGateway.create once, however many GET requests follow and whatever the lookups answer',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          unreachableCreateFailureArbitrary,
          fc.array(
            fc.record({
              elapsedMs: fc.integer({ min: 0, max: 40_000 }),
              lookup: lookupScenarioArbitrary,
            }),
            { minLength: 1, maxLength: 6 },
          ),
          async (key, body, failure, steps) => {
            const testApp = await createTransactionsHttpApp();
            try {
              const id = await createPendingWithoutExternalId(testApp, body, key, failure);
              expect(testApp.gateway.callCount('create')).toBe(1);
              testApp.gateway.script.getStatus.always(ok(matchingStatus('PENDING', body.quantity)));
              testApp.gateway.script.findByReference.enqueue(
                ...steps.map((step) => lookupResult(step.lookup, body.quantity)),
              );

              for (const step of steps) {
                testApp.clock.advance(step.elapsedMs);
                const response = await getTransactionRequest(testApp, id);
                expect(response.status).toBe(200);
                expect(testApp.gateway.callCount('create')).toBe(1);
              }

              expect(testApp.gateway.callLog.filter((call) => call === 'create')).toHaveLength(1);
              expect(testApp.gateway.script.create.calls).toHaveLength(1);
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
