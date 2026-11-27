import { type Currency, createMoney, addMoney, equalMoney, multiplyMoney } from './money';

describe('Money', () => {
  it('creates a COP value from non-negative safe integer cents', () => {
    const result = createMoney(120000);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ amountInCents: 120000, currency: 'COP' });
  });

  it('accepts zero', () => {
    expect(createMoney(0)._unsafeUnwrap().amountInCents).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %p as INVALID_AMOUNTS',
    (value) => {
      expect(createMoney(value)._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
    },
  );

  it('adds two values in integer cents', () => {
    const sum = addMoney(createMoney(300000)._unsafeUnwrap(), createMoney(800000)._unsafeUnwrap());
    expect(sum._unsafeUnwrap().amountInCents).toBe(1100000);
  });

  it('rejects an addition that leaves the safe integer range', () => {
    const big = createMoney(Number.MAX_SAFE_INTEGER)._unsafeUnwrap();
    const one = createMoney(1)._unsafeUnwrap();
    expect(addMoney(big, one)._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
  });

  it('multiplies by a non-negative integer factor', () => {
    const product = multiplyMoney(createMoney(12000000)._unsafeUnwrap(), 2);
    expect(product._unsafeUnwrap().amountInCents).toBe(24000000);
  });

  it.each([-1, 0.5, Number.NaN])('rejects the multiplication factor %p', (factor) => {
    const price = createMoney(100)._unsafeUnwrap();
    expect(multiplyMoney(price, factor)._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
  });

  it('rejects a product that leaves the safe integer range', () => {
    const price = createMoney(Number.MAX_SAFE_INTEGER)._unsafeUnwrap();
    expect(multiplyMoney(price, 2)._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
  });

  it('compares equal amounts in the same currency', () => {
    const left = createMoney(500)._unsafeUnwrap();
    const right = createMoney(500)._unsafeUnwrap();
    expect(equalMoney(left, right)).toBe(true);
    expect(equalMoney(left, createMoney(501)._unsafeUnwrap())).toBe(false);
  });

  it('treats different currencies as unequal', () => {
    const left = createMoney(500)._unsafeUnwrap();
    const other = { amountInCents: 500, currency: 'USD' as unknown as Currency };
    expect(equalMoney(left, other)).toBe(false);
  });
});
