import { err, ok, type Result } from 'neverthrow';
import { envSchema, VARIABLES_WITH_DEFAULTS } from './env.schema';

export interface AppConfig {
  readonly paymentApiUrl: string;
  readonly paymentPublicKey: string;
  readonly paymentPrivateKeyParam: string;
  readonly paymentIntegritySecretParam: string;
  readonly paymentEventsSecretParam: string;
  readonly originVerifySecretParam: string;
  readonly baseFeeInCents: number;
  readonly deliveryFeeInCents: number;
  readonly tables: {
    readonly products: string;
    readonly customers: string;
    readonly transactions: string;
    readonly deliveries: string;
    readonly idempotencyKeys: string;
  };
}

// Carries the variable name only. Values are never included, so logs stay free of secrets.
export interface ConfigError {
  readonly kind: 'MISSING_ENV_VAR' | 'INVALID_ENV_VAR';
  readonly variableName: string;
}

const isBlank = (value: string | undefined): value is undefined | '' =>
  value === undefined || value.trim() === '';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<AppConfig, ConfigError> {
  const candidate: Record<string, string> = {};

  for (const variableName of Object.keys(envSchema.shape)) {
    const value = env[variableName];
    if (isBlank(value)) {
      if (VARIABLES_WITH_DEFAULTS.has(variableName)) {
        continue;
      }
      return err({ kind: 'MISSING_ENV_VAR', variableName });
    }
    candidate[variableName] = value;
  }

  const parsed = envSchema.safeParse(candidate);
  if (!parsed.success) {
    const variableName = String(parsed.error.issues[0]?.path[0] ?? '');
    return err({ kind: 'INVALID_ENV_VAR', variableName });
  }

  const data = parsed.data;
  return ok({
    paymentApiUrl: data.PAYMENT_API_URL,
    paymentPublicKey: data.PAYMENT_PUBLIC_KEY,
    paymentPrivateKeyParam: data.PAYMENT_PRIVATE_KEY_PARAM,
    paymentIntegritySecretParam: data.PAYMENT_INTEGRITY_SECRET_PARAM,
    paymentEventsSecretParam: data.PAYMENT_EVENTS_SECRET_PARAM,
    originVerifySecretParam: data.ORIGIN_VERIFY_SECRET_PARAM,
    baseFeeInCents: data.BASE_FEE_IN_CENTS,
    deliveryFeeInCents: data.DELIVERY_FEE_IN_CENTS,
    tables: {
      products: data.DYNAMODB_TABLE_PRODUCTS,
      customers: data.DYNAMODB_TABLE_CUSTOMERS,
      transactions: data.DYNAMODB_TABLE_TRANSACTIONS,
      deliveries: data.DYNAMODB_TABLE_DELIVERIES,
      idempotencyKeys: data.DYNAMODB_TABLE_IDEMPOTENCY_KEYS,
    },
  });
}
