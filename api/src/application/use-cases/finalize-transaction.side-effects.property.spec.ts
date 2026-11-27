import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import {
  createDynamoWorld,
  createInMemoryWorld,
  type FinalizationWorld,
} from '../../../test/support/finalization-world';
import { finalStatusArbitrary } from '../../../test/support/reconciliation-helpers';
import { providerMessageArbitrary } from '../../../test/support/transaction-property-helpers';
import { providerReason } from '../provider-reason';

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

const scenarioArbitrary = fc.record({
  quantity: fc.integer({ min: 1, max: 5 }),
  // Enough stock for the whole quantity: the BACKORDER case is Property 33.
  extraStock: fc.integer({ min: 0, max: 20 }),
  status: finalStatusArbitrary,
  message: fc.option(providerMessageArbitrary, { nil: null }),
});

// Feature: payments-api, Property 30: Finalization applies the correct side effects per outcome
describe('Feature: payments-api, Property 30: Finalization applies the correct side effects per outcome', () => {
  describe.each(backends)('over %s', (_name, createWorld) => {
    it('gives each Final_Status its Transaction, Delivery and stock effects when the Amount_Check matches', async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async ({ quantity, extraStock, status, message }) => {
          const stockBefore = quantity + extraStock;
          const world = createWorld(stockBefore);
          const pending = world.seed({ index: 1, quantity });
          const reason = status === 'APPROVED' ? undefined : providerReason(message);

          const result = await world.finalize.execute(pending, {
            source: 'provider',
            status,
            ...(reason === undefined ? {} : { statusReason: reason }),
            report: {
              amountInCents: pending.totalInCents,
              currency: pending.currency,
              reference: pending.reference,
            },
          });

          const approved = status === 'APPROVED';
          const stored = world.snapshot(pending);
          expect(result.isOk()).toBe(true);
          expect(result._unsafeUnwrap().status).toBe(status);
          expect(stored.transaction.status).toBe(status);
          expect(stored.transaction.finalizedAt).toBe(world.clock.now().toISOString());
          expect(stored.deliveryStatus).toBe(approved ? 'ASSIGNED' : 'CANCELLED');
          expect(stored.stock).toBe(approved ? stockBefore - quantity : stockBefore);
          expect(stored.transaction.statusReason).toBe(
            approved ? undefined : (message ?? undefined),
          );
          expect(world.logger.at('alert')).toHaveLength(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  it('sends one TransactWriteItems per finalization, with the conditional stock decrement only for APPROVED', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ quantity, extraStock, status, message }) => {
        const world = createDynamoWorld(ddb, quantity + extraStock);
        const pending = world.seed({ index: 1, quantity });
        const reason = status === 'APPROVED' ? undefined : providerReason(message);

        await world.finalize.execute(pending, {
          source: 'provider',
          status,
          ...(reason === undefined ? {} : { statusReason: reason }),
          report: {
            amountInCents: pending.totalInCents,
            currency: pending.currency,
            reference: pending.reference,
          },
        });

        const calls = ddb.commandCalls(TransactWriteCommand);
        expect(calls).toHaveLength(1);
        const items = calls[0]?.args[0].input.TransactItems ?? [];
        const approved = status === 'APPROVED';
        expect(items).toHaveLength(approved ? 3 : 2);
        expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({
          ':status': status,
          ':pending': 'PENDING',
        });
        expect(items[1]?.Update?.ExpressionAttributeValues?.[':status']).toBe(
          approved ? 'ASSIGNED' : 'CANCELLED',
        );
        if (approved) {
          expect(items[2]?.Update?.ConditionExpression).toBe('#stock >= :quantity');
          expect(items[2]?.Update?.ExpressionAttributeValues).toEqual({ ':quantity': quantity });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
