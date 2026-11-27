import * as fc from 'fast-check';
import request from 'supertest';
import { ok } from 'neverthrow';
import type { TransactionStatus } from '../../../domain/transaction-status';
import {
  createTransactionsHttpApp,
  TRANSACTION_PRODUCT,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  FIXED_KEY,
  NUM_RUNS,
  PROVIDER_EXTERNAL_ID,
  PROPERTY_TIMEOUT_MS,
  postTransaction,
  providerAnswer,
  providerMessageArbitrary,
  providerStatusArbitrary,
  totalFor,
  transactionBodyArbitrary,
  type TransactionBody,
} from '../../../../test/support/transaction-property-helpers';
import type { ProviderStatus } from '../../../application/ports/payment-gateway';

const AMOUNT_MISMATCH_REASON = 'AMOUNT_MISMATCH';

/** The stored outcome of one Transaction, as far as the provider status can change it. */
interface Outcome {
  readonly status: TransactionStatus;
  readonly statusReason: string | undefined;
  readonly deliveryStatus: string | undefined;
  readonly stock: number | undefined;
  readonly finalized: boolean;
}

interface Scenario {
  readonly status: TransactionStatus;
  readonly message: string | null;
  readonly mismatched: boolean;
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  status: providerStatusArbitrary,
  message: fc.option(providerMessageArbitrary, { nil: null }),
  mismatched: fc.boolean(),
});

function reportOf(body: TransactionBody, scenario: Scenario): ProviderStatus {
  const answer = providerAnswer(scenario.status, body.quantity, {
    message: scenario.message,
    ...(scenario.mismatched ? { amountInCents: totalFor(body.quantity) + 1 } : {}),
  });
  return {
    status: answer.status,
    message: answer.message,
    amountInCents: answer.amountInCents,
    currency: answer.currency,
    reference: answer.reference,
  };
}

function outcomeOf(testApp: TransactionsHttpApp, id: string): Outcome {
  const stored = testApp.transactions.get(id);
  if (stored === undefined) {
    throw new Error('test setup: the transaction was not stored');
  }
  return {
    status: stored.status,
    statusReason: stored.statusReason,
    deliveryStatus: testApp.deliveries.get(stored.deliveryId)?.status,
    stock: testApp.products.stockOf(TRANSACTION_PRODUCT.id),
    finalized: stored.finalizedAt !== undefined,
  };
}

/** Provider status arrives in the create response (task 3.28 path). */
async function viaCreate(body: TransactionBody, scenario: Scenario): Promise<Outcome> {
  const testApp = await createTransactionsHttpApp();
  try {
    testApp.gateway.script.create.always(
      ok({ ...reportOf(body, scenario), externalId: PROVIDER_EXTERNAL_ID }),
    );
    const response = await postTransaction(testApp, body, FIXED_KEY);
    expect(response.status).toBe(201);
    const outcome = outcomeOf(testApp, response.body.id as string);
    expect(response.body.status).toBe(outcome.status);
    return outcome;
  } finally {
    await testApp.app.close();
  }
}

/** Same status arrives later, through `GET /transactions/:id` (sync path). */
async function viaSync(body: TransactionBody, scenario: Scenario): Promise<Outcome> {
  const testApp = await createTransactionsHttpApp();
  try {
    testApp.gateway.script.create.always(ok(providerAnswer('PENDING', body.quantity)));
    const created = await postTransaction(testApp, body, FIXED_KEY);
    const id = created.body.id as string;
    testApp.clock.advance(1_000);
    testApp.gateway.script.getStatus.always(ok(reportOf(body, scenario)));
    const response = await request(testApp.app.getHttpServer())
      .get(`/api/v1/transactions/${id}`)
      .expect(200);
    const outcome = outcomeOf(testApp, id);
    expect(response.body.status).toBe(outcome.status);
    return outcome;
  } finally {
    await testApp.app.close();
  }
}

// Feature: payments-api, Property 24: Provider acceptance updates the transaction according to its reported status (sync part)
describe('Feature: payments-api, Property 24: Provider acceptance updates the transaction according to its reported status (sync part)', () => {
  it(
    'stores on sync the same result as the same status arriving on create, and keeps PENDING without finalizing',
    async () => {
      await fc.assert(
        fc.asyncProperty(transactionBodyArbitrary, scenarioArbitrary, async (body, scenario) => {
          const synced = await viaSync(body, scenario);
          if (scenario.status === 'PENDING') {
            expect(synced.status).toBe('PENDING');
            expect(synced.finalized).toBe(false);
            expect(synced.deliveryStatus).toBe('PENDING');
            return;
          }
          // A mismatch overrides any reported status and the sync must run the same Amount_Check.
          const created = await viaCreate(body, scenario);
          expect(synced).toEqual(created);
          expect(synced.finalized).toBe(true);
          if (scenario.mismatched) {
            expect(synced.statusReason).toBe(AMOUNT_MISMATCH_REASON);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
