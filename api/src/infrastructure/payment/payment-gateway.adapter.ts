import { err, ok, ResultAsync, type Result } from 'neverthrow';
import { z } from 'zod';
import type { PaymentGatewayError } from '../../application/errors';
import type {
  AcceptanceLink,
  AcceptanceTokens,
  PaymentGateway,
} from '../../application/ports/payment-gateway';
import type { AppConfig } from '../config/env.config';
import {
  STANDARD_PROFILE_TIMING,
  withStandardProfile,
  type ProviderAttempt,
  type StandardTiming,
} from './provider-call-policy';

/**
 * Adapter for the payment provider. It implements only the methods of the port that exist so far:
 * `create` (branch 3) and `getStatus`/`findByReference` (branch 4) arrive with their own tasks, so
 * the adapter never exposes a method that answers with a placeholder error.
 */
export type PaymentGatewayAcceptance = Pick<PaymentGateway, 'getAcceptanceTokens'>;

export type PaymentGatewayAdapterConfig = Pick<AppConfig, 'paymentApiUrl' | 'paymentPublicKey'>;

// Provider response shape for `GET /merchants/{publicKey}`. Only these fields are read; unknown
// fields are dropped by Zod. Permalinks are rendered as links, so only https is accepted.
const acceptanceLinkSchema = z.object({
  acceptance_token: z.string().min(1),
  permalink: z.url({ protocol: /^https$/ }),
});

const merchantSchema = z.object({
  data: z.object({
    presigned_acceptance: acceptanceLinkSchema,
    presigned_personal_data_auth: acceptanceLinkSchema,
  }),
});

type MerchantPayload = z.infer<typeof merchantSchema>;

const UNKNOWN_EXCEPTION_REASON = 'UnknownError';
const SCHEMA_MISMATCH_REASON = 'SchemaMismatch';

const toAcceptanceLink = (link: z.infer<typeof acceptanceLinkSchema>): AcceptanceLink => ({
  token: link.acceptance_token,
  permalink: link.permalink,
});

export const mapMerchantToAcceptanceTokens = (payload: MerchantPayload): AcceptanceTokens => ({
  acceptanceToken: toAcceptanceLink(payload.data.presigned_acceptance),
  acceptPersonalAuth: toAcceptanceLink(payload.data.presigned_personal_data_auth),
});

const parseMerchant = (body: unknown): Result<AcceptanceTokens, PaymentGatewayError> => {
  const parsed = merchantSchema.safeParse(body);
  if (!parsed.success) {
    return err({ kind: 'INVALID_RESPONSE', reason: SCHEMA_MISMATCH_REASON });
  }
  return ok(mapMerchantToAcceptanceTokens(parsed.data));
};

// Reads `name` instead of using `instanceof Error`, which fails for errors created in another realm
// (for example the SyntaxError that `Response.json()` raises inside the fetch implementation).
const exceptionName = (cause: unknown): string =>
  typeof cause === 'object' && cause !== null && 'name' in cause && typeof cause.name === 'string'
    ? cause.name
    : UNKNOWN_EXCEPTION_REASON;

const jsonFailure = (cause: unknown): PaymentGatewayError => ({
  kind: 'INVALID_RESPONSE',
  reason: exceptionName(cause),
});

export class PaymentGatewayAdapter implements PaymentGatewayAcceptance {
  constructor(
    private readonly config: PaymentGatewayAdapterConfig,
    private readonly timing: StandardTiming = STANDARD_PROFILE_TIMING,
  ) {}

  /** Standard_Profile. Errors carry a reason only; the URL, key, token and body are never included. */
  getAcceptanceTokens(): ResultAsync<AcceptanceTokens, PaymentGatewayError> {
    return withStandardProfile(this.merchantAttempt(), this.timing).andThen((response) =>
      ResultAsync.fromPromise(response.json(), jsonFailure).andThen(parseMerchant),
    );
  }

  private merchantAttempt(): ProviderAttempt {
    const url = `${this.config.paymentApiUrl.replace(/\/+$/, '')}/merchants/${encodeURIComponent(
      this.config.paymentPublicKey,
    )}`;
    return (signal) =>
      fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal,
      });
  }
}
