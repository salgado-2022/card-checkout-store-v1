import { err, ok, type Result } from 'neverthrow';
import type { DomainError } from './errors';
/** Transaction reference: `ORD-` followed by a 26-character ULID (Crockford base32, uppercase). */
export type Reference = string & { readonly __brand: 'Reference' };
const REFERENCE_PREFIX = 'ORD-';
const REFERENCE_PATTERN = /^ORD-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export function isValidReference(value: string): value is Reference {
  return REFERENCE_PATTERN.test(value);
}
/** Builds `ORD-<ulid>`; fails with `INVALID_REFERENCE` when the ULID does not produce a valid reference. */
export function createReference(ulid: string): Result<Reference, DomainError> {
  const candidate = `${REFERENCE_PREFIX}${ulid}`;
  return isValidReference(candidate) ? ok(candidate) : err({ kind: 'INVALID_REFERENCE' });
}
