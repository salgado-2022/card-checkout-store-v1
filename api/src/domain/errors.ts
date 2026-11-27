/**
 * Business errors returned by domain functions inside a neverthrow `Result`.
 * Each variant carries only non-sensitive fields.
 */
export type DomainError =
  | { readonly kind: 'INSUFFICIENT_STOCK'; readonly available: number }
  | { readonly kind: 'INVALID_TRANSITION'; readonly from: string; readonly to: string }
  | { readonly kind: 'INVALID_AMOUNTS' }
  | { readonly kind: 'INVALID_REFERENCE' };
