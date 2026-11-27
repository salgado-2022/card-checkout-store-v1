import * as fc from 'fast-check';
import request from 'supertest';
import { ok } from 'neverthrow';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  FIXED_KEY,
  NUM_RUNS,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  transactionBodyArbitrary,
} from '../../../../test/support/transaction-property-helpers';

const TRANSACTIONS_PATH = '/api/v1/transactions';
const KNOWN_RESPONSE_STATUSES: readonly string[] = [
  'PENDING',
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
];
const UNKNOWN_STATUS_WARNING = 'provider reported an unknown status, transaction kept pending';

// The adapter maps any status text outside PENDING, APPROVED, DECLINED, VOIDED and ERROR to
// `UNKNOWN` before the use case runs (see payment-gateway.adapter.status.spec.ts). The port carries
// no other field for that case, so the use case receives exactly `{ status: 'UNKNOWN' }`. The
// property therefore varies the transaction the status arrives for.

// Feature: payments-api, Property 29: Unrecognized Provider status values are rejected safely
describe('Feature: payments-api, Property 29: Unrecognized Provider status values are rejected safely', () => {
  it(
    'keeps the Transaction PENDING, logs a warning and answers 200 with a known status for any unknown provider status',
    async () => {
      await fc.assert(
        fc.asyncProperty(transactionBodyArbitrary, async (body) => {
          const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
          try {
            testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
            const created = await postTransaction(testApp, body, FIXED_KEY);
            const id = created.body.id as string;
            testApp.gateway.script.getStatus.always(ok({ status: 'UNKNOWN' }));

            const response = await request(testApp.app.getHttpServer())
              .get(`${TRANSACTIONS_PATH}/${id}`)
              .expect(200);

            expect(KNOWN_RESPONSE_STATUSES).toContain(response.body.status);
            expect(response.body.status).toBe('PENDING');
            const stored = testApp.transactions.get(id);
            expect(stored?.status).toBe('PENDING');
            expect(stored?.finalizedAt).toBeUndefined();
            expect(testApp.logger.at('warn').map((entry) => entry.message)).toContain(
              UNKNOWN_STATUS_WARNING,
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
