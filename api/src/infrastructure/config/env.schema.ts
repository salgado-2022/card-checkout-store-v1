import { z } from 'zod';

export const DEFAULT_BASE_FEE_IN_CENTS = 300000;
export const DEFAULT_DELIVERY_FEE_IN_CENTS = 800000;

const nonEmptyText = z.string().min(1);

// Fees arrive as strings from the environment: digits only, converted to a non-negative integer.
const feeInCents = (defaultValue: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value))
    .pipe(z.int().nonnegative())
    .default(defaultValue);

export const envSchema = z.object({
  PAYMENT_API_URL: z.url(),
  PAYMENT_PUBLIC_KEY: nonEmptyText,
  PAYMENT_PRIVATE_KEY_PARAM: nonEmptyText,
  PAYMENT_INTEGRITY_SECRET_PARAM: nonEmptyText,
  PAYMENT_EVENTS_SECRET_PARAM: nonEmptyText,
  ORIGIN_VERIFY_SECRET_PARAM: nonEmptyText,
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
