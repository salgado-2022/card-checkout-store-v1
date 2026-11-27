import { GetFees } from './get-fees';

describe('GetFees', () => {
  it('echoes the configured fees with currency COP', () => {
    const result = new GetFees({ baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 }).execute();

    expect(result._unsafeUnwrap()).toEqual({
      currency: 'COP',
      baseFeeInCents: 300_000,
      deliveryFeeInCents: 800_000,
    });
  });

  it('reflects other configured values without any hard-coded default', () => {
    const result = new GetFees({ baseFeeInCents: 1_250, deliveryFeeInCents: 0 }).execute();

    expect(result._unsafeUnwrap()).toEqual({
      currency: 'COP',
      baseFeeInCents: 1_250,
      deliveryFeeInCents: 0,
    });
  });

  it('always returns Ok, never Err', () => {
    const result = new GetFees({ baseFeeInCents: 0, deliveryFeeInCents: 0 }).execute();

    expect(result.isOk()).toBe(true);
  });
});
