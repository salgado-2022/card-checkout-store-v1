import { err, ok, ResultAsync, type Result } from 'neverthrow';
import { z } from 'zod';
import type { PaymentGatewayError } from '../../application/errors';
import type {
  AcceptanceLink,
  AcceptanceTokens,
  PaymentCreateRequest,
  PaymentCreateResponse,
  PaymentGateway,
} from '../../application/ports/payment-gateway';
import { TRANSACTION_STATUSES } from '../../domain/transaction-status';
import type { AppConfig } from '../config/env.config';
import { SsmParameterReader, type SsmParameterError } from '../config/ssm-parameter-reader';
import { computeIntegritySignature } from './integrity-signature';
import {
  MAX_BODY_BYTES,
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

export type PaymentGatewayAdapterConfig = Pick<
  AppConfig,
  'paymentApiUrl' | 'paymentPublicKey' | 'paymentPrivateKeyParam' | 'paymentIntegritySecretParam'
>;
/** Resolves a decrypted SSM parameter by name. `SsmParameterReader` is the production source. */
export type ParameterSource = Pick<SsmParameterReader, 'load'>;

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

// Provider response shape for `POST /transactions`. Only these fields are read.
const createSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.enum(TRANSACTION_STATUSES),
    status_message: z.string().nullish(),
    reference: z.string().min(1),
    amount_in_cents: z.number().int().nonnegative(),
    currency: z.string().min(1),
  }),
});
const errorBodySchema = z.object({ error: z.object({ type: z.string() }) });
type MerchantPayload = z.infer<typeof merchantSchema>;

// Reason recorded when a 4xx body carries no usable `error.type`. Provider free text is never kept.
const REJECTED_FALLBACK_MESSAGE = 'PROVIDER_REJECTED';
const ERROR_TYPE_PATTERN = /^[A-Z_]{1,64}$/;
const SECRET_UNAVAILABLE_REASON = 'SecretUnavailable';
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

const parseCreated = (body: unknown): Result<PaymentCreateResponse, PaymentGatewayError> => {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return err({ kind: 'INVALID_RESPONSE', reason: SCHEMA_MISMATCH_REASON });
  }
  const { data } = parsed.data;
  return ok({
    externalId: data.id,
    status: data.status,
    message: data.status_message ?? null,
    amountInCents: data.amount_in_cents,
    currency: data.currency,
    reference: data.reference,
  });
};
/**
 * Reduces a 4xx body to a safe code: `error.type` when it is upper-case letters and underscores,
 * `PROVIDER_REJECTED` otherwise. The provider's free text is never returned.
 */
export const rejectionMessageFrom = (bodyText: string): string => {
  if (bodyText.length > MAX_BODY_BYTES) return REJECTED_FALLBACK_MESSAGE;
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return REJECTED_FALLBACK_MESSAGE;
  }
  const parsed = errorBodySchema.safeParse(json);
  return parsed.success && ERROR_TYPE_PATTERN.test(parsed.data.error.type)
    ? parsed.data.error.type
    : REJECTED_FALLBACK_MESSAGE;
};
const secretFailure = (error: SsmParameterError): PaymentGatewayError => ({
  kind: 'UNAVAILABLE',
  reason: `${SECRET_UNAVAILABLE_REASON}:${error.reason}`,
});
const jsonFailure = (cause: unknown): PaymentGatewayError => ({
  kind: 'INVALID_RESPONSE',
  reason: exceptionName(cause),
});

export class PaymentGatewayAdapter
  implements PaymentGatewayAcceptance, Pick<PaymentGateway, 'create'>
{
  constructor(
    private readonly config: PaymentGatewayAdapterConfig,
    private readonly timing: StandardTiming = STANDARD_PROFILE_TIMING,
    private readonly secrets: ParameterSource = new SsmParameterReader(),
  ) {}
  /**
   * Standard_Profile. The only method that sends a creation request. The private key, integrity
   * secret and card token are used for the request and never appear in an error or a log line.
   */
  create(request: PaymentCreateRequest): ResultAsync<PaymentCreateResponse, PaymentGatewayError> {
    return ResultAsync.combine([
      this.secrets.load(this.config.paymentPrivateKeyParam),
      this.secrets.load(this.config.paymentIntegritySecretParam),
    ])
      .mapErr(secretFailure)
      .andThen(([privateKey, integritySecret]) => {
        const rejection = { message: REJECTED_FALLBACK_MESSAGE };
        const attempt = this.createAttempt(request, privateKey, integritySecret, rejection);
        return withStandardProfile(attempt, this.timing).mapErr((error): PaymentGatewayError =>
          error.kind === 'REJECTED' ? { ...error, providerMessage: rejection.message } : error,
        );
      })
      .andThen((response) =>
        ResultAsync.fromPromise(response.json(), jsonFailure).andThen(parseCreated),
      );
  }
  private createAttempt(
    request: PaymentCreateRequest,
    privateKey: string,
    integritySecret: string,
    rejection: { message: string },
  ): ProviderAttempt {
    const url = `${this.config.paymentApiUrl.replace(/\/+$/, '')}/transactions`;
    const body = JSON.stringify({
      amount_in_cents: request.amountInCents,
      currency: request.currency,
      customer_email: request.customerEmail,
      reference: request.reference,
      acceptance_token: request.acceptanceToken,
      accept_personal_auth: request.acceptPersonalAuth,
      payment_method: {
        type: 'CARD',
        token: request.cardToken,
        installments: request.installments,
      },
      signature: computeIntegritySignature(
        request.reference,
        request.amountInCents,
        request.currency,
        integritySecret,
      ),
    });
    return async (signal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${privateKey}`,
        },
        body,
        redirect: 'manual',
        signal,
      });
      if (response.status >= 400 && response.status < 500) {
        rejection.message = rejectionMessageFrom(await response.clone().text());
      }
      return response;
    };
  }

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
