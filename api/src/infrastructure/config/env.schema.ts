import { z } from 'zod';

export const DEFAULT_BASE_FEE_IN_CENTS = 300000;
export const DEFAULT_DELIVERY_FEE_IN_CENTS = 800000;

const nonEmptyText = z.string().min(1);
// SSM parameter names: absolute path made of letters, digits and _ . / - only.
const ssmParameterName = z.string().regex(/^\/[A-Za-z0-9_./-]+$/);
// Only the public key (pub_...) may be configured here; a private key (prv_...) is rejected.
const paymentPublicKey = z.string().regex(/^pub_\S+$/);

// Fees arrive as strings from the environment: digits only, converted to a non-negative integer.
const feeInCents = (defaultValue: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value))
    .pipe(z.int().nonnegative())
    .default(defaultValue);

export const envSchema = z.object({
  PAYMENT_API_URL: z.url({ protocol: /^https$/ }),
  PAYMENT_PUBLIC_KEY: paymentPublicKey,
  PAYMENT_PRIVATE_KEY_PARAM: ssmParameterName,
  PAYMENT_INTEGRITY_SECRET_PARAM: ssmParameterName,
  PAYMENT_EVENTS_SECRET_PARAM: ssmParameterName,
  ORIGIN_VERIFY_SECRET_PARAM: ssmParameterName,
  BASE_FEE_IN_CENTS: feeInCents(DEFAULT_BASE_FEE_IN_CENTS),
  DELIVERY_FEE_IN_CENTS: feeInCents(DEFAULT_DELIVERY_FEE_IN_CENTS),
  DYNAMODB_TABLE_PRODUCTS: nonEmptyText,
  DYNAMODB_TABLE_CUSTOMERS: nonEmptyText,
  DYNAMODB_TABLE_TRANSACTIONS: nonEmptyText,
  DYNAMODB_TABLE_DELIVERIES: nonEmptyText,
  DYNAMODB_TABLE_IDEMPOTENCY_KEYS: nonEmptyText,
});

export type ValidatedEnv = z.output<typeof envSchema>;

// Variables that fall back to a default when unset or blank. Every other schema key is required.
export const VARIABLES_WITH_DEFAULTS: ReadonlySet<string> = new Set([
  'BASE_FEE_IN_CENTS',
  'DELIVERY_FEE_IN_CENTS',
]);
