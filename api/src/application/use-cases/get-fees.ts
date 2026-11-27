import { ok, type Result } from 'neverthrow';
import { CURRENCY } from '../../domain/money';

export interface FeeSchedule {
  readonly baseFeeInCents: number;
  readonly deliveryFeeInCents: number;
}

export interface FeesView extends FeeSchedule {
  readonly currency: typeof CURRENCY;
}

export class GetFees {
  constructor(private readonly fees: FeeSchedule) {}

  execute(): Result<FeesView, never> {
    return ok({
      currency: CURRENCY,
      baseFeeInCents: this.fees.baseFeeInCents,
      deliveryFeeInCents: this.fees.deliveryFeeInCents,
    });
  }
}
