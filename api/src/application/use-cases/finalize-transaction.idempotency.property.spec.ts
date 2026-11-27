import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import {
  createDynamoWorld,
  createInMemoryWorld,
  type FinalizationWorld,
} from '../../../test/support/finalization-world';
import { finalStatusArbitrary } from '../../../test/support/reconciliation-helpers';
import type { Transaction } from '../../domain/entities';
import type { FinalStatus } from '../../domain/transaction-status';
import type { FinalStatusOutcome } from './finalize-transaction';

const NUM_RUNS = 100;

const ddb = mockClient(DynamoDBDocumentClient);

afterAll(() => {
  ddb.restore();
});

const backends: ReadonlyArray<readonly [string, (stock: number) => FinalizationWorld]> = [
  ['in-memory repositories', (stock) => createInMemoryWorld(stock)],
  [
    'DynamoDB adapter over a stateful aws-sdk-client-mock',
    (stock) => createDynamoWorld(ddb, stock),
  ],
];

// What a caller may report: any Final_Status with matching or differing amounts, or an internal ERROR.
type OutcomeSpec =
  | { readonly kind: 'provider'; readonly status: FinalStatus; readonly mismatched: boolean }
  | { readonly kind: 'internal' };

const outcomeSpecArbitrary: fc.Arbitrary<OutcomeSpec> = fc.oneof(
  fc.record({
    kind: fc.constant('provider' as const),
    status: finalStatusArbitrary,
    mismatched: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('internal' as const) }),
);

function toOutcome(spec: OutcomeSpec, transaction: Transaction): FinalStatusOutcome {
  if (spec.kind === 'internal') {
    return { source: 'internal', status: 'ERROR', statusReason: 'PROVIDER_UNREACHABLE' };
  }
  return {
    source: 'provider',
    status: spec.status,
    ...(spec.status === 'APPROVED' ? {} : { statusReason: 'SOME_REASON' }),
    report: {
      amountInCents: transaction.totalInCents + (spec.mismatched ? 1 : 0),
      currency: transaction.currency,
      reference: transaction.reference,
    },
  };
}

// Feature: payments-api, Property 31: Finalization is idempotent
describe('Feature: payments-api, Property 31: Finalization is idempotent', () => {
  describe.each(backends)('over %s', (_name, createWorld) => {
    it('leaves the stock, the Delivery and the Transaction as the first call left them, however often and with whatever status it runs again', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 0, max: 20 }),
          outcomeSpecArbitrary,
          fc.array(outcomeSpecArbitrary, { minLength: 1, maxLength: 8 }),
          fc.boolean(),
          async (quantity, extraStock, first, repeats, refreshCopy) => {
            const stockBefore = quantity + extraStock;
            const world = createWorld(stockBefore);
            const pending = world.seed({ index: 1, quantity });

            const firstResult = await world.finalize.execute(pending, toOutcome(first, pending));
            expect(firstResult.isOk()).toBe(true);
            const afterFirst = world.snapshot(pending);
            const approved = afterFirst.transaction.status === 'APPROVED';
            expect(afterFirst.stock).toBe(approved ? stockBefore - quantity : stockBefore);
            expect(world.writes()).toBe(1);

            // A caller may hold the stale PENDING copy or the refreshed one: both must be harmless.
            let held: Transaction = refreshCopy ? afterFirst.transaction : pending;
            for (const repeat of repeats) {
              const result = await world.finalize.execute(held, toOutcome(repeat, pending));

              expect(result.isOk()).toBe(true);
              expect(result._unsafeUnwrap()).toEqual(afterFirst.transaction);
              expect(world.snapshot(pending)).toEqual(afterFirst);
              expect(world.writes()).toBe(1);
              held = refreshCopy ? result._unsafeUnwrap() : pending;
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
