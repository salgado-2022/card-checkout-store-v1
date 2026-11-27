import type { ResultAsync } from 'neverthrow';
import type { TransactionStatus } from '../../domain/transaction-status';
import type { PaymentGatewayError } from '../errors';

export interface AcceptanceLink {
  readonly token: string;
  readonly permalink: string;
}

export interface AcceptanceTokens {
  readonly acceptanceToken: AcceptanceLink;
  readonly acceptPersonalAuth: AcceptanceLink;
}

/**
 * Provider-reported state of a payment. `amountInCents`, `currency` and `reference` are the
 * three fields the Amount_Check compares against the stored Transaction.
 */
export interface ProviderStatus {
  readonly status: TransactionStatus;
  readonly message: string | null;
  readonly amountInCents: number;
  readonly currency: string;
  readonly reference: string;
}

/** The integrity signature is computed by the adapter; callers never see the secret. */
export interface PaymentCreateRequest {
  readonly reference: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly customerEmail: string;
  readonly acceptanceToken: string;
  /** Personal-data authorization token returned by `getAcceptanceTokens` (`acceptPersonalAuth.token`). */
  readonly acceptPersonalAuth: string;
  /** Held in memory for this call only; never stored or logged. */
  readonly cardToken: string;
  readonly installments: number;
}

export interface PaymentCreateResponse extends ProviderStatus {
  readonly externalId: string;
}

export type ReconciliationOutcome =
  | { readonly kind: 'found'; readonly externalId: string; readonly status: ProviderStatus }
  | { readonly kind: 'not_found' };

export interface PaymentGateway {
  /** Standard_Profile: 10 s timeout, one retry after a 500 ms backoff on timeout or 5xx, never on 4xx. */
  getAcceptanceTokens(): ResultAsync<AcceptanceTokens, PaymentGatewayError>;
  /** Standard_Profile: 10 s timeout, one retry after a 500 ms backoff on timeout or 5xx, never on 4xx. */
  create(request: PaymentCreateRequest): ResultAsync<PaymentCreateResponse, PaymentGatewayError>;
  /** Single_Attempt_Profile: 3 s timeout, exactly one attempt, no retry (client polling is the retry). */
  getStatus(externalId: string): ResultAsync<ProviderStatus, PaymentGatewayError>;
  /**
   * Single_Attempt_Profile: 3 s timeout, exactly one attempt, no retry.
   * Read-only lookup by OUR reference, used only when no External_Id is known yet (Requirement 8).
   * Never issues a creation call. A clean "no such reference" answer is `Ok({ kind: 'not_found' })`.
   */
  findByReference(reference: string): ResultAsync<ReconciliationOutcome, PaymentGatewayError>;
}
