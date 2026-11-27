import { createHash } from 'node:crypto';

/**
 * Integrity_Signature sent to the payment provider with a creation request:
 * the SHA-256 hex digest of the reference, the amount in cents, the currency
 * and the integrity secret, concatenated in that order without separators.
 */
export function computeIntegritySignature(
  reference: string,
  amountInCents: number,
  currency: string,
  secret: string,
): string {
  return createHash('sha256')
    .update(`${reference}${amountInCents}${currency}${secret}`, 'utf8')
    .digest('hex');
}
