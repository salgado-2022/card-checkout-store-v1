import * as fc from 'fast-check';
import { computeAmounts } from './amounts';

// Feature: payments-api, Property 12: Amounts invariant
describe('Feature: payments-api, Property 12: Amounts invariant', () => {
  const cents = fc.integer({ min: 0, max: 1_000_000_000 });

  it('keeps subtotal = unit price × quantity and total = subtotal + both fees, all integers', () => {
    fc.assert(
      fc.property(
        cents,
        fc.integer({ min: 1, max: 5 }),
        cents,
        cents,
        (unitPriceInCents, quantity, baseFeeInCents, deliveryFeeInCents) => {
          const result = computeAmounts(
            unitPriceInCents,
            quantity,
            baseFeeInCents,
            deliveryFeeInCents,
          );
          expect(result.isOk()).toBe(true);
          const amounts = result._unsafeUnwrap();

          expect(amounts.subtotalInCents).toBe(unitPriceInCents * quantity);
          expect(amounts.totalInCents).toBe(
            amounts.subtotalInCents + baseFeeInCents + deliveryFeeInCents,
          );
          for (const value of [
            amounts.subtotalInCents,
            amounts.baseFeeInCents,
            amounts.deliveryFeeInCents,
            amounts.totalInCents,
          ]) {
            expect(Number.isInteger(value)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('matches the known vector 12000000 × 2 + 300000 + 800000 = 25100000', () => {
    const amounts = computeAmounts(12000000, 2, 300000, 800000)._unsafeUnwrap();
    expect(amounts.subtotalInCents).toBe(24000000);
    expect(amounts.totalInCents).toBe(25100000);
  });
});
