import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import { ResultAsync } from 'neverthrow';
import {
  createDynamoWorld,
  createInMemoryWorld,
  WORLD_PRODUCT_ID,
  type FinalizationWorld,
} from '../../../test/support/finalization-world';
import { finalStatusArbitrary } from '../../../test/support/reconciliation-helpers';
import type { FinalStatus } from '../../domain/transaction-status';
import type { TransactionRepository } from '../ports/transaction-repository';
import { FinalizeTransaction, type FinalStatusOutcome } from './finalize-transaction';

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

function matchingOutcome(
  status: FinalStatus,
  report: { totalInCents: number; currency: string; reference: string },
): FinalStatusOutcome {
  return {
    source: 'provider',
    status,
    report: {
      amountInCents: report.totalInCents,
      currency: report.currency,
      reference: report.reference,
    },
  };
}

// Feature: payments-api, Property 33: Approval without enough stock produces BACKORDER, never negative stock
describe('Feature: payments-api, Property 33: Approval without enough stock produces BACKORDER, never negative stock', () => {
  describe.each(backends)('over %s', (_name, createWorld) => {
    it('approves the Transaction, sets the Delivery to BACKORDER, leaves the stock alone and raises an alert with the Reference and product id', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.nat({ max: 4 }),
          async (quantity, shortBy) => {
            const stockBefore = Math.max(0, quantity - 1 - shortBy);
            const world = createWorld(stockBefore);
            const pending = world.seed({ index: 1, quantity });

            const result = await world.finalize.execute(
              pending,
              matchingOutcome('APPROVED', pending),
            );

            const stored = world.snapshot(pending);
            expect(result.isOk()).toBe(true);
            expect(stored.transaction.status).toBe('APPROVED');
            expect(stored.transaction.finalizedAt).toBeDefined();
            expect(stored.deliveryStatus).toBe('BACKORDER');
            expect(stored.stock).toBe(stockBefore);
            const alerts = world.logger.at('alert');
            expect(alerts).toHaveLength(1);
            expect(alerts[0]?.fields).toMatchObject({
              reference: pending.reference,
              productId: WORLD_PRODUCT_ID,
            });
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  it('never takes the stock below 0 when finalizations of different transactions are interleaved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 0, max: 15 }),
        fc.array(
          fc.record({ quantity: fc.integer({ min: 1, max: 5 }), status: finalStatusArbitrary }),
          {
            minLength: 2,
            maxLength: 8,
          },
        ),
        async (scheduler, stockBefore, requests) => {
          const world = createInMemoryWorld(stockBefore);
          // Every write to the repository waits for the scheduler, so the first attempt and the
          // BACKORDER retry of different transactions run in an arbitrary interleaved order.
          const scheduledFinalize = scheduler.scheduleFunction(
            async (input: Parameters<TransactionRepository['finalize']>[0]) =>
              world.repository.finalize(input),
          );
          const interleaved: TransactionRepository = {
            findById: (id) => world.repository.findById(id),
            findByReference: (reference) => world.repository.findByReference(reference),
            create: (input) => world.repository.create(input),
            setExternalId: (id, externalId) => world.repository.setExternalId(id, externalId),
            setLastSynced: (id, at) => world.repository.setLastSynced(id, at),
            finalize: (input) => new ResultAsync(scheduledFinalize(input)),
          };
          const finalize = new FinalizeTransaction(interleaved, world.logger, world.clock);
          const pendings = requests.map((request, position) =>
            world.seed({ index: position + 1, quantity: request.quantity }),
          );

          const running = pendings.map((pending, position) =>
            finalize.execute(
              pending,
              matchingOutcome(requests[position]?.status ?? 'ERROR', pending),
            ),
          );
          await scheduler.waitAll();
          const results = await Promise.all(running);

          expect(results.every((result) => result.isOk())).toBe(true);
          const snapshots = pendings.map((pending) => world.snapshot(pending));
          const assignedQuantity = snapshots.reduce(
            (sum, snapshot) =>
              snapshot.deliveryStatus === 'ASSIGNED' ? sum + snapshot.transaction.quantity : sum,
            0,
          );
          expect(world.stock()).toBeGreaterThanOrEqual(0);
          expect(world.stock()).toBe(stockBefore - assignedQuantity);

          const backorders = snapshots.filter(
            (snapshot) => snapshot.deliveryStatus === 'BACKORDER',
          );
          snapshots.forEach((snapshot, position) => {
            const status = requests[position]?.status;
            expect(snapshot.transaction.status).toBe(status);
            if (status === 'APPROVED') {
              expect(['ASSIGNED', 'BACKORDER']).toContain(snapshot.deliveryStatus);
            } else {
              expect(snapshot.deliveryStatus).toBe('CANCELLED');
            }
          });
          expect(world.logger.at('alert')).toHaveLength(backorders.length);
          backorders.forEach((snapshot) => {
            // The stock only ever goes down, so a BACKORDER means it was short at that moment and still is.
            expect(world.stock()).toBeLessThan(snapshot.transaction.quantity);
            expect(world.logger.at('alert')).toContainEqual(
              expect.objectContaining({
                fields: expect.objectContaining({
                  reference: snapshot.transaction.reference,
                  productId: WORLD_PRODUCT_ID,
                }),
              }),
            );
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
