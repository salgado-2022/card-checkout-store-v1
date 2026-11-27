export type AmountCheckField = 'amountInCents' | 'currency' | 'reference';

export interface ReportedAmount {
  readonly amountInCents: number;
  readonly currency: string;
  readonly reference: string;
}

export interface StoredAmount {
  readonly totalInCents: number;
  readonly currency: string;
  readonly reference: string;
}

export type AmountCheckResult =
  { readonly kind: 'match' } | { readonly kind: 'mismatch'; readonly fields: AmountCheckField[] };

/**
 * Compares what the payment provider reports with what the API stored, by strict equality.
 * A mismatch lists the differing fields in the fixed order amountInCents, currency, reference.
 */
export function checkAmount(reported: ReportedAmount, stored: StoredAmount): AmountCheckResult {
  const fields: AmountCheckField[] = [];
  if (reported.amountInCents !== stored.totalInCents) {
    fields.push('amountInCents');
  }
  if (reported.currency !== stored.currency) {
    fields.push('currency');
  }
  if (reported.reference !== stored.reference) {
    fields.push('reference');
  }
  return fields.length === 0 ? { kind: 'match' } : { kind: 'mismatch', fields };
}
