import { computeAmounts } from './amounts';

describe('computeAmounts', () => {
  it('computes the documented vector: 12000000 × 2 + 300000 + 800000 = 25100000', () => {
    const result = computeAmounts(12000000, 2, 300000, 800000);
    expect(result._unsafeUnwrap()).toEqual({
      currency: 'COP',
      subtotalInCents: 24000000,
      baseFeeInCents: 300000,
      deliveryFeeInCents: 800000,
      totalInCents: 25100000,
    });
  });

  it('computes a single unit with zero fees', () => {
    const amounts = computeAmounts(5000, 1, 0, 0)._unsafeUnwrap();
    expect(amounts.subtotalInCents).toBe(5000);
    expect(amounts.totalInCents).toBe(5000);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the quantity %p as INVALID_AMOUNTS', (quantity) => {
    expect(computeAmounts(5000, quantity, 0, 0)._unsafeUnwrapErr()).toEqual({
      kind: 'INVALID_AMOUNTS',
    });
  });

  it.each([
    ['unit price', [1.5, 1, 0, 0]],
    ['base fee', [5000, 1, -1, 0]],
    ['delivery fee', [5000, 1, 0, 2.5]],
  ] as const)('rejects an invalid %s', (_label, args) => {
    const [unit, quantity, base, delivery] = args;
    expect(computeAmounts(unit, quantity, base, delivery)._unsafeUnwrapErr()).toEqual({
      kind: 'INVALID_AMOUNTS',
    });
  });

  it('rejects a total that leaves the safe integer range', () => {
    const result = computeAmounts(Number.MAX_SAFE_INTEGER, 1, 1, 0);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
  });

  it('rejects a subtotal that leaves the safe integer range', () => {
    const result = computeAmounts(Number.MAX_SAFE_INTEGER, 2, 0, 0);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
  });

  it('rejects a total that overflows when the delivery fee is added', () => {
    const result = computeAmounts(Number.MAX_SAFE_INTEGER - 1, 1, 1, 1);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
  });
});
