import * as fc from 'fast-check';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';
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
  RECONCILIATION_WINDOW_MS,
  unreachableCreateFailureArbitrary,
} from '../../../../test/support/reconciliation-helpers';

// Ages around the 60 s boundary are over-represented so that both sides of it are exercised.
const ageArbitrary = fc.oneof(
  fc.integer({ min: 0, max: RECONCILIATION_WINDOW_MS - 1 }),
  fc.constantFrom(0, RECONCILIATION_WINDOW_MS - 1, RECONCILIATION_WINDOW_MS),
  fc.integer({ min: RECONCILIATION_WINDOW_MS, max: 600_000 }),
);

// Feature: payments-api, Property 27: Reconciliation outcomes are applied correctly and only when needed
describe('Feature: payments-api, Property 27: Reconciliation outcomes are applied correctly and only when needed', () => {
  it(
    'applies the lookup outcome by age and result, with exactly one lookup attempt per GET',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          unreachableCreateFailureArbitrary,
          ageArbitrary,
          lookupScenarioArbitrary,
          async (key, body, failure, ageMs, lookup) => {
            const testApp = await createTransactionsHttpApp();
            try {
              const id = await createPendingWithoutExternalId(testApp, body, key, failure);
              const stockBefore = testApp.products.stockOf(TRANSACTION_PRODUCT.id) ?? 0;
              const deliveryId = testApp.transactions.get(id)?.deliveryId ?? '';
              testApp.logger.entries.length = 0;
              testApp.gateway.script.findByReference.always(lookupResult(lookup, body.quantity));
              testApp.clock.advance(ageMs);

              const response = await getTransactionRequest(testApp, id);

              expect(response.status).toBe(200);
              expect(testApp.gateway.callCount('findByReference')).toBe(1);
              expect(testApp.gateway.script.findByReference.calls[0]).toEqual([
                testApp.transactions.get(id)?.reference,
              ]);
              expect(testApp.gateway.callCount('getStatus')).toBe(0);
              expect(testApp.gateway.callCount('create')).toBe(1);

              const stored = testApp.transactions.get(id);
              const delivery = testApp.deliveries.get(deliveryId);
              const stockAfter = testApp.products.stockOf(TRANSACTION_PRODUCT.id);
              expect(response.body.status).toBe(stored?.status);

              if (lookup.kind === 'found') {
                expect(stored?.externalId).toBe(lookup.externalId);
                expect(stored?.status).toBe(lookup.status);
                if (lookup.status === 'PENDING') {
                  expect(stored?.finalizedAt).toBeUndefined();
                  expect(delivery?.status).toBe('PENDING');
                  expect(stockAfter).toBe(stockBefore);
                } else {
                  const approved = lookup.status === 'APPROVED';
                  expect(stored?.finalizedAt).toBeDefined();
                  expect(delivery?.status).toBe(approved ? 'ASSIGNED' : 'CANCELLED');
                  expect(stockAfter).toBe(approved ? stockBefore - body.quantity : stockBefore);
                }
                expect(testApp.logger.at('warn')).toHaveLength(0);
                return;
              }

              expect(stored?.externalId).toBeUndefined();
              if (lookup.kind === 'not_found' && ageMs >= RECONCILIATION_WINDOW_MS) {
                expect(stored?.status).toBe('ERROR');
                expect(stored?.statusReason).toBe('PROVIDER_UNREACHABLE');
                expect(stored?.finalizedAt).toBeDefined();
                expect(delivery?.status).toBe('CANCELLED');
                expect(stockAfter).toBe(stockBefore);
                expect(response.body.statusReason).toBe('PROVIDER_UNREACHABLE');
                return;
              }

              // Younger than the window, or the lookup itself failed: nothing is written.
              expect(stored?.status).toBe('PENDING');
              expect(stored?.finalizedAt).toBeUndefined();
              expect(stored?.statusReason).toBeUndefined();
              expect(delivery?.status).toBe('PENDING');
              expect(stockAfter).toBe(stockBefore);
              expect(response.body.status).toBe('PENDING');
              if (lookup.kind === 'error') {
                const warnings = testApp.logger.at('warn');
                expect(warnings).toHaveLength(1);
                expect(warnings[0]?.fields.reference).toBe(stored?.reference);
              } else {
                expect(testApp.logger.at('warn')).toHaveLength(0);
              }
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
