import * as fc from 'fast-check';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  expectNoTransactionWrites,
  postTransaction,
  validTransactionBodyArbitrary,
  type PlainBody,
} from '../../../../test/support/transaction-request-fixtures';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 120_000;

// Spaces and tabs only. The HTTP parser trims them, so the server sees an empty header value.
const whitespaceOnlyKeyArbitrary = fc.stringMatching(/^[ \t]{1,12}$/);

const missingKeyArbitrary: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant<string | null>(null),
  fc.constant<string | null>(''),
  whitespaceOnlyKeyArbitrary,
);

// Feature: payments-api, Property 16: Idempotency key format is enforced
describe('Feature: payments-api, Property 16: Idempotency key format is enforced', () => {
  it(
    'rejects an absent, empty or whitespace-only Idempotency-Key with 400 MISSING_IDEMPOTENCY_KEY and no write',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validTransactionBodyArbitrary,
          missingKeyArbitrary,
          async (body: PlainBody, key) => {
            const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
            const beginSpy = jest.spyOn(testApp.idempotency, 'begin');
            try {
              const response = await postTransaction(testApp, JSON.stringify(body), key);

              expect(response.status).toBe(400);
              expect(response.body).toMatchObject({
                statusCode: 400,
                code: 'MISSING_IDEMPOTENCY_KEY',
              });
              expectNoTransactionWrites(testApp);
              expect(beginSpy).not.toHaveBeenCalled();
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
