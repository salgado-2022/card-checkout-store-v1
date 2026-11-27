import * as fc from 'fast-check';
import { ok } from 'neverthrow';
import { TRANSACTION_PRODUCT } from '../../../test/support/transactions-http-app';
import { createUseCaseWorld } from '../../../test/support/use-case-world';
import {
  PROVIDER_EXTERNAL_ID,
  providerAnswer,
  providerMessageArbitrary,
  transactionBodyArbitrary,
  FIXED_KEY,
  totalFor,
  referenceOfFirstAttempt,
} from '../../../test/support/transaction-property-helpers';
import { finalStatusArbitrary } from '../../../test/support/reconciliation-helpers';
import type { AmountCheckField } from '../../domain/amount-check';
import type { FinalStatus } from '../../domain/transaction-status';
import { providerReason } from '../provider-reason';
import type { CreateTransactionRequest } from './create-transaction';

const NUM_RUNS = 100;

// Which of the three compared fields the report gets wrong. All false means an exact match.
const differencesArbitrary = fc.record({
  amountInCents: fc.boolean(),
  currency: fc.boolean(),
  reference: fc.boolean(),
});

const scenarioArbitrary = fc.record({
  body: transactionBodyArbitrary,
  status: finalStatusArbitrary,
  message: fc.option(providerMessageArbitrary, { nil: null }),
  differences: differencesArbitrary,
  amountOffset: fc.integer({ min: 1, max: 5_000_000 }),
  wrongCurrency: fc.constantFrom('USD', 'cop', 'EUR', ''),
  wrongReference: fc.stringMatching(/^ORD-[0-9A-Z]{6}$/),
});
type Scenario = typeof scenarioArbitrary extends fc.Arbitrary<infer T> ? T : never;

/** The report the provider sends: exact values, with the chosen fields replaced by wrong ones. */
function reportFor(scenario: Scenario) {
  const { differences } = scenario;
  return {
    status: scenario.status,
    message: scenario.message,
    amountInCents:
      totalFor(scenario.body.quantity) + (differences.amountInCents ? scenario.amountOffset : 0),
    currency: differences.currency ? scenario.wrongCurrency : 'COP',
    reference: differences.reference ? scenario.wrongReference : referenceOfFirstAttempt(),
  };
}

function differingFields(scenario: Scenario): AmountCheckField[] {
  const { differences } = scenario;
  return [
    ...(differences.amountInCents ? (['amountInCents'] as const) : []),
    ...(differences.currency ? (['currency'] as const) : []),
    ...(differences.reference ? (['reference'] as const) : []),
  ];
}

type Caller = 'create' | 'sync';

/** Runs one scenario through the chosen caller and returns the world to inspect plus the stored id. */
async function runThrough(caller: Caller, scenario: Scenario) {
  const world = createUseCaseWorld();
  const report = reportFor(scenario);
  const request = scenario.body as CreateTransactionRequest;
  const reportedStatus: FinalStatus = scenario.status;
  if (caller === 'create') {
    world.gateway.script.create.always(
      ok(providerAnswer(reportedStatus, scenario.body.quantity, report)),
    );
  } else {
    world.gateway.script.create.always(
      ok(providerAnswer('PENDING', scenario.body.quantity, { externalId: PROVIDER_EXTERNAL_ID })),
    );
    world.gateway.script.getStatus.always(ok(report));
  }
  const created = await world.createTransaction.execute({ idempotencyKey: FIXED_KEY, request });
  const id = (created._unsafeUnwrap().body as { id: string }).id;
  if (caller === 'sync') {
    world.clock.advance(2_000);
    (await world.syncTransactionStatus.execute(id))._unsafeUnwrap();
  }
  return { world, id };
}

// Feature: payments-api, Property 46: Amount_Check gates finalization, overriding even an APPROVED report
describe('Feature: payments-api, Property 46: Amount_Check gates finalization, overriding even an APPROVED report (FinalizeTransaction)', () => {
  describe.each<Caller>(['create', 'sync'])('driven through the %s caller', (caller) => {
    it('turns any report with a differing field into ERROR AMOUNT_MISMATCH, and applies an exactly matching report as reported', async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          const { world, id } = await runThrough(caller, scenario);
          const stored = world.transactions.get(id);
          const delivery = world.deliveries.get(stored?.deliveryId ?? '');
          const stockAfter = world.products.stockOf(TRANSACTION_PRODUCT.id);
          const differing = differingFields(scenario);
          const alerts = world.logger.at('alert');

          expect(stored?.finalizedAt).toBeDefined();
          if (differing.length > 0) {
            expect(stored?.status).toBe('ERROR');
            expect(stored?.statusReason).toBe('AMOUNT_MISMATCH');
            expect(delivery?.status).toBe('CANCELLED');
            expect(stockAfter).toBe(TRANSACTION_PRODUCT.stock);
            expect(alerts).toHaveLength(1);
            expect(alerts[0]?.fields).toEqual({
              reference: stored?.reference,
              fields: differing.join(','),
            });
            return;
          }

          const approved = scenario.status === 'APPROVED';
          expect(stored?.status).toBe(scenario.status);
          expect(delivery?.status).toBe(approved ? 'ASSIGNED' : 'CANCELLED');
          expect(stockAfter).toBe(
            approved
              ? TRANSACTION_PRODUCT.stock - scenario.body.quantity
              : TRANSACTION_PRODUCT.stock,
          );
          expect(stored?.statusReason).toBe(
            approved ? undefined : providerReason(scenario.message),
          );
          expect(alerts).toHaveLength(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
