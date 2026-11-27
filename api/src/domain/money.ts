import { err, ok, type Result } from 'neverthrow';
import type { DomainError } from './errors';

export const CURRENCY = 'COP';
export type Currency = typeof CURRENCY;

/** Non-negative integer amount in cents of the single supported currency. */
export interface Money {
  readonly amountInCents: number;
  readonly currency: Currency;
}

/** Builds a Money value. Rejects negative numbers, decimals and values outside the safe integer range. */
export function createMoney(amountInCents: number): Result<Money, DomainError> {
  if (!Number.isSafeInteger(amountInCents) || amountInCents < 0) {
    return err({ kind: 'INVALID_AMOUNTS' });
  }
  return ok({ amountInCents, currency: CURRENCY });
}

export function addMoney(left: Money, right: Money): Result<Money, DomainError> {
  return createMoney(left.amountInCents + right.amountInCents);
}

/** Multiplies by a non-negative integer factor, such as a quantity. */
export function multiplyMoney(money: Money, factor: number): Result<Money, DomainError> {
  if (!Number.isSafeInteger(factor) || factor < 0) {
    return err({ kind: 'INVALID_AMOUNTS' });
  }
  return createMoney(money.amountInCents * factor);
}

export function equalMoney(left: Money, right: Money): boolean {
  return left.amountInCents === right.amountInCents && left.currency === right.currency;
}
