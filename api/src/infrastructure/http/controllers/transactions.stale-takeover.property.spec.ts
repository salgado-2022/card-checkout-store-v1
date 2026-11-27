import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import { createTransactionsHttpApp } from '../../../../test/support/transactions-http-app';
import {
  FIXED_KEY,
  idempotencyKeyArbitrary,
  NUM_RUNS,
  OTHER_KEY,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  seedInProgressRecord,
  STALE_AFTER_MS,
  transactionBodyArbitrary,
  type TransactionBody,
} from '../../../../test/support/transaction-property-helpers';
import type { TransactionsHttpApp } from '../../../../test/support/transactions-http-app';
import { envelopeFor } from '../error-catalog';

const MAX_EXTRA_AGE_MS = 120_000;
const staleAgeArbitrary = fc.integer({
  min: STALE_AFTER_MS,
  max: STALE_AFTER_MS + MAX_EXTRA_AGE_MS,
});

/** Creates a Transaction under another key, then leaves `key` as a stale record that points at it. */
async function staleRecordWithTransaction(
  testApp: TransactionsHttpApp,
  key: string,
  body: TransactionBody,
): Promise<string> {
  const first = await postTransaction(testApp, body, OTHER_KEY);
  if (first.status !== 201) {
    throw new Error('test setup: the first transaction was not created');
  }
  const transactionId = first.body.id as string;
  await seedInProgressRecord(testApp, key, body);
  await testApp.idempotency.attachTransactionId(key, transactionId);
  return transactionId;
}

// Feature: payments-api, Property 20: Stale in-progress records recover without duplicating work
describe('Feature: payments-api, Property 20: Stale in-progress records recover without duplicating work', () => {
  it(
    'answers with the current state of the stored transaction and writes nothing',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          staleAgeArbitrary,
          async (key, body, ageMs) => {
            const testApp = await createTransactionsHttpApp();
            try {
              testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
              const transactionId = await staleRecordWithTransaction(testApp, key, body);
              testApp.clock.advance(ageMs);
              const transactionsBefore = testApp.transactions.count();
              const callsBefore = testApp.gateway.callCount('create');

              const response = await postTransaction(testApp, body, key);

              expect(response.status).toBe(200);
              expect(response.body.id).toBe(transactionId);
              expect(response.body.status).toBe(testApp.transactions.get(transactionId)?.status);
              expect(testApp.transactions.count()).toBe(transactionsBefore);
              expect(testApp.deliveries.count()).toBe(1);
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

  it(
    'takes over a stale record without transaction id and processes the request exactly once',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idempotencyKeyArbitrary,
          transactionBodyArbitrary,
          staleAgeArbitrary,
          async (key, body, ageMs) => {
            const testApp = await createTransactionsHttpApp();
            try {
              testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
              await seedInProgressRecord(testApp, key, body);
              testApp.clock.advance(ageMs);

              const response = await postTransaction(testApp, body, key);

              expect(response.status).toBe(201);
              expect(response.body.status).toBe('PENDING');
              expect(testApp.gateway.callLog).toEqual(['create']);
              expect(testApp.transactions.count()).toBe(1);
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

  it(
    'lets exactly one of two racing requests take over a stale record',
    async () => {
      await fc.assert(
        fc.asyncProperty(transactionBodyArbitrary, staleAgeArbitrary, async (body, ageMs) => {
          const testApp = await createTransactionsHttpApp();
          try {
            testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
            await seedInProgressRecord(testApp, FIXED_KEY, body);
            testApp.clock.advance(ageMs);

            const [left, right] = await Promise.all([
              postTransaction(testApp, body, FIXED_KEY),
              postTransaction(testApp, body, FIXED_KEY),
            ]);
            const responses = [left, right];
            const created = responses.filter((response) => response.status === 201);
            const loser = responses.find((response) => response.status !== 201);

            expect(created).toHaveLength(1);
            expect(loser).toBeDefined();
            expect([200, 409]).toContain(loser?.status);
            if (loser?.status === 200) {
              expect(loser.body).toEqual(created[0]?.body);
            } else {
              expect(loser?.body).toEqual(envelopeFor('IDEMPOTENCY_KEY_IN_PROGRESS'));
            }
            expect(testApp.gateway.callCount('create')).toBe(1);
            expect(testApp.transactions.count()).toBe(1);
            expect(testApp.deliveries.count()).toBe(1);
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
