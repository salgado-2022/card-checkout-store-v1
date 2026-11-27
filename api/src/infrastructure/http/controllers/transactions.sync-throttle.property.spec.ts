import * as fc from 'fast-check';
import request from 'supertest';
import { err, ok, type Result } from 'neverthrow';
import type { PaymentGatewayError } from '../../../application/errors';
import type { ProviderStatusReport } from '../../../application/ports/payment-gateway';
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

const MIN_SYNC_INTERVAL_MS = 1_000;
const TRANSACTIONS_PATH = '/api/v1/transactions';

/** What the provider answers to one `GET` that reaches it: a status, or a failed call. */
type Reply = 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'failed';

interface Step {
  readonly advanceMs: number;
  readonly reply: Reply;
}

const replyArbitrary: fc.Arbitrary<Reply> = fc.constantFrom<Reply>(
  'PENDING',
  'PENDING',
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
  'failed',
);

// Gaps around the 1 s boundary are over-represented so the >= comparison is exercised.
const advanceArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 2_500 }),
  fc.constantFrom(0, 999, 1_000, 1_001),
);

const stepsArbitrary: fc.Arbitrary<readonly Step[]> = fc.array(
  fc.record({ advanceMs: advanceArbitrary, reply: replyArbitrary }),
  { minLength: 1, maxLength: 8 },
);

function asReport(reply: Exclude<Reply, 'failed'>, quantity: number): ProviderStatusReport {
  const answer = providerAnswer(reply, quantity);
  return {
    status: answer.status,
    message: answer.message,
    amountInCents: answer.amountInCents,
    currency: answer.currency,
    reference: answer.reference,
  };
}

function replyResult(
  reply: Reply,
  quantity: number,
): Result<ProviderStatusReport, PaymentGatewayError> {
  return reply === 'failed'
    ? err({ kind: 'UNAVAILABLE', reason: 'AbortError' })
    : ok(asReport(reply, quantity));
}

// Feature: payments-api, Property 28: Provider sync is throttled to once per second and skipped once final
describe('Feature: payments-api, Property 28: Provider sync is throttled to once per second and skipped once final', () => {
  it(
    'calls the provider only when the last sync is at least 1 s old, updates lastSyncedAt on each call, and never after a final status',
    async () => {
      await fc.assert(
        fc.asyncProperty(transactionBodyArbitrary, stepsArbitrary, async (body, steps) => {
          const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
          try {
            testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
            const created = await postTransaction(testApp, body, FIXED_KEY);
            const id = created.body.id as string;
            const initialSync = testApp.transactions.get(id)?.lastSyncedAt;
            let lastSyncedMs: number | undefined =
              initialSync === undefined ? undefined : Date.parse(initialSync);
            let finalReached = false;
            let expectedCalls = 0;

            for (const step of steps) {
              testApp.clock.advance(step.advanceMs);
              const nowMs = testApp.clock.now().getTime();
              testApp.gateway.script.getStatus.always(replyResult(step.reply, body.quantity));

              const due =
                lastSyncedMs === undefined || nowMs - lastSyncedMs >= MIN_SYNC_INTERVAL_MS;
              const shouldCall = !finalReached && due;
              if (shouldCall) {
                expectedCalls += 1;
                lastSyncedMs = nowMs;
              }

              const response = await request(testApp.app.getHttpServer())
                .get(`${TRANSACTIONS_PATH}/${id}`)
                .expect(200);

              expect(testApp.gateway.callCount('getStatus')).toBe(expectedCalls);
              const stored = testApp.transactions.get(id);
              if (shouldCall) {
                expect(stored?.lastSyncedAt).toBe(testApp.clock.now().toISOString());
              }
              expect(response.body.status).toBe(stored?.status);

              if (step.reply !== 'PENDING' && step.reply !== 'failed') {
                // A final status applies once; afterwards the provider is never asked again.
                if (shouldCall) finalReached = true;
              }
            }
            expect(testApp.gateway.callCount('findByReference')).toBe(0);
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
