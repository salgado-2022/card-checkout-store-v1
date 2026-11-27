import { err, Result } from 'neverthrow';
import type { DomainError } from './errors';
import { addMoney, createMoney, CURRENCY, type Currency, multiplyMoney } from './money';

export interface Amounts {
  readonly currency: Currency;
  readonly subtotalInCents: number;
  readonly baseFeeInCents: number;
  readonly deliveryFeeInCents: number;
  readonly totalInCents: number;
}

/**
 * The single place that computes the amounts of a purchase:
 * subtotal = unit price × quantity, total = subtotal + base fee + delivery fee.
 * All values are integer cents.
 */
export function computeAmounts(
  unitPriceInCents: number,
  quantity: number,
  baseFeeInCents: number,
  deliveryFeeInCents: number,
): Result<Amounts, DomainError> {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return err({ kind: 'INVALID_AMOUNTS' });
  }
  return Result.combine([
    createMoney(unitPriceInCents),
    createMoney(baseFeeInCents),
    createMoney(deliveryFeeInCents),
  ]).andThen(([unitPrice, baseFee, deliveryFee]) =>
    multiplyMoney(unitPrice, quantity).andThen((subtotal) =>
      addMoney(subtotal, baseFee)
        .andThen((withBaseFee) => addMoney(withBaseFee, deliveryFee))
        .map((total): Amounts => ({
          currency: CURRENCY,
          subtotalInCents: subtotal.amountInCents,
          baseFeeInCents: baseFee.amountInCents,
          deliveryFeeInCents: deliveryFee.amountInCents,
          totalInCents: total.amountInCents,
        })),
    ),
  );
}
