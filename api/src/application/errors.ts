/**
 * Application-layer errors returned inside a neverthrow `Result`.
 * Every variant carries only a `kind` and non-sensitive fields: never SDK messages,
 * card tokens, card data or secrets.
 */

/** A persistence adapter failed unexpectedly. `reason` is an exception class name, never its message. */
export interface RepositoryError {
  readonly kind: 'REPOSITORY_ERROR';
  readonly reason: string;
}

/**
 * Failure of a payment gateway call.
 * - `REJECTED`: HTTP 4xx. `providerMessage` is the message the provider returned for the rejection
 *   (stored as `statusReason`); `afterTransientFailure` is true when the 4xx answered the retry that
 *   followed a timeout or 5xx on the first attempt.
 * - `UNAVAILABLE`: timeout or 5xx after the retry allowed by the profile.
 * - `INVALID_RESPONSE`: the provider answered but the payload could not be understood.
 */
export type PaymentGatewayError =
  | {
      readonly kind: 'REJECTED';
      readonly providerMessage: string;
      readonly afterTransientFailure: boolean;
    }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string }
  | { readonly kind: 'INVALID_RESPONSE'; readonly reason: string };

export interface ValidationErrorDetail {
  readonly field: string;
  readonly rule: string;
}

/**
 * Errors produced by use cases. `INSUFFICIENT_STOCK` is not repeated here: it is a `DomainError`.
 * A `PaymentGatewayError` never reaches the HTTP layer directly: use cases translate it into
 * `PAYMENT_PROVIDER_ERROR` or absorb it (stay PENDING).
 */
export type ApplicationError =
  | RepositoryError
  | { readonly kind: 'VALIDATION_ERROR'; readonly details: readonly ValidationErrorDetail[] }
  | { readonly kind: 'MISSING_IDEMPOTENCY_KEY' }
  | { readonly kind: 'IDEMPOTENCY_KEY_REUSED' }
  | { readonly kind: 'IDEMPOTENCY_KEY_IN_PROGRESS' }
  | { readonly kind: 'PRODUCT_NOT_FOUND' }
  | { readonly kind: 'CUSTOMER_NOT_FOUND' }
  | { readonly kind: 'TRANSACTION_NOT_FOUND' }
  | { readonly kind: 'DELIVERY_NOT_FOUND' }
  | { readonly kind: 'PAYMENT_PROVIDER_ERROR' };
