import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';
import {
  FIXED_KEY,
  idempotencyKeyArbitrary,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  PROVIDER_EXTERNAL_ID,
  postTransaction,
  providerAnswer,
  providerMessageArbitrary,
  providerStatusArbitrary,
  transactionBodyArbitrary,
} from '../../../../test/support/transaction-property-helpers';

const AMOUNT_MISMATCH_REASON = 'AMOUNT_MISMATCH';

// Feature: payments-api, Property 24: Provider acceptance updates the transaction according to its reported status (create part)
describe('Feature: payments-api, Property 24: Provider acceptance updates the transaction according to its reported status (create part)', () => {
  it(
    'stores the External_Id and the final status before answering, with stock changed only for an approved, matching report',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          providerStatusArbitrary,
          fc.option(providerMessageArbitrary, { nil: null }),
          fc.boolean(),
          async (key, body, status, message, mismatched) => {
            const testApp = await createTransactionsHttpApp();
            try {
              const reportedAmount = mismatched
                ? providerAnswer(status, body.quantity).amountInCents + 1
                : undefined;
              testApp.gateway.script.create.always(
                ok(
                  providerAnswer(status, body.quantity, {
                    message,
                    ...(reportedAmount === undefined ? {} : { amountInCents: reportedAmount }),
                  }),
                ),
              );
              const stockBefore = testApp.products.stockOf(TRANSACTION_PRODUCT.id) ?? 0;

              const response = await postTransaction(testApp, body, key);

              expect(response.status).toBe(201);
              const stored = testApp.transactions.get(response.body.id as string);
              expect(stored?.externalId).toBe(PROVIDER_EXTERNAL_ID);
              expect(response.body.status).toBe(stored?.status);
              expect(testApp.gateway.callCount('create')).toBe(1);

              if (status === 'PENDING') {
                expect(response.body.status).toBe('PENDING');
                expect(stored?.finalizedAt).toBeUndefined();
                expect(testApp.deliveries.get(stored?.deliveryId ?? '')?.status).toBe('PENDING');
                expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(stockBefore);
                return;
              }

              // A final status always passes the Amount_Check first; a mismatch turns it into ERROR.
              const finalStatus = mismatched ? 'ERROR' : status;
              expect(response.body.status).toBe(finalStatus);
              expect(stored?.finalizedAt).toBeDefined();
              const approved = finalStatus === 'APPROVED';
              expect(testApp.deliveries.get(stored?.deliveryId ?? '')?.status).toBe(
                approved ? 'ASSIGNED' : 'CANCELLED',
              );
              expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(
                approved ? stockBefore - body.quantity : stockBefore,
              );
              if (mismatched) {
                expect(stored?.statusReason).toBe(AMOUNT_MISMATCH_REASON);
              } else if (finalStatus !== 'APPROVED' && message !== null) {
                expect(stored?.statusReason).toBe(message);
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

  it(
    'approves once: a second request with the same key does not decrement stock again',
    async () => {
      await fc.assert(
        fc.asyncProperty(transactionBodyArbitrary, async (body) => {
          const testApp = await createTransactionsHttpApp();
          try {
            testApp.gateway.script.create.always(ok(providerAnswer('APPROVED', body.quantity)));
            await postTransaction(testApp, body, FIXED_KEY);
            const replay = await postTransaction(testApp, body, FIXED_KEY);

            expect(replay.status).toBe(200);
            expect(testApp.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(
              TRANSACTION_PRODUCT.stock - body.quantity,
            );
          } finally {
            await testApp.app.close();
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
