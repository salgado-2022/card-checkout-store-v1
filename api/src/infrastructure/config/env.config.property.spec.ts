import fc from 'fast-check';
import { loadConfig } from './env.config';

const NUM_RUNS = 200;

const VALID_ENV: Record<string, string> = {
  PAYMENT_API_URL: 'https://payment.test.example/v1',
  PAYMENT_PUBLIC_KEY: 'pub_test_fake',
  PAYMENT_PRIVATE_KEY_PARAM: '/card-checkout/test/payment-private-key',
  PAYMENT_INTEGRITY_SECRET_PARAM: '/card-checkout/test/payment-integrity-secret',
  PAYMENT_EVENTS_SECRET_PARAM: '/card-checkout/test/payment-events-secret',
  ORIGIN_VERIFY_SECRET_PARAM: '/card-checkout/test/origin-verify-secret',
  DYNAMODB_TABLE_PRODUCTS: 'test-products',
  DYNAMODB_TABLE_CUSTOMERS: 'test-customers',
  DYNAMODB_TABLE_TRANSACTIONS: 'test-transactions',
  DYNAMODB_TABLE_DELIVERIES: 'test-deliveries',
  DYNAMODB_TABLE_IDEMPOTENCY_KEYS: 'test-idempotency-keys',
};

const REQUIRED_VARIABLES = [
  'PAYMENT_API_URL',
  'PAYMENT_PUBLIC_KEY',
  'PAYMENT_PRIVATE_KEY_PARAM',
  'PAYMENT_INTEGRITY_SECRET_PARAM',
  'PAYMENT_EVENTS_SECRET_PARAM',
  'ORIGIN_VERIFY_SECRET_PARAM',
  'DYNAMODB_TABLE_PRODUCTS',
  'DYNAMODB_TABLE_CUSTOMERS',
  'DYNAMODB_TABLE_TRANSACTIONS',
  'DYNAMODB_TABLE_DELIVERIES',
  'DYNAMODB_TABLE_IDEMPOTENCY_KEYS',
];

const FEE_VARIABLES = ['BASE_FEE_IN_CENTS', 'DELIVERY_FEE_IN_CENTS'];

// 'omit', 'empty' and 'whitespace' all count as unset. 'secret' sets a value that looks like a
// credential; it only breaks the config for variables that validate their format.
type Corruption = 'omit' | 'empty' | 'whitespace' | 'secret';

interface Breakage {
  readonly variableName: string;
  readonly corruption: Corruption;
}

const breakagesFor = (variableName: string): Breakage[] => {
  if (FEE_VARIABLES.includes(variableName)) {
    return [{ variableName, corruption: 'secret' }];
  }
  const corruptions: Corruption[] =
    variableName === 'PAYMENT_API_URL'
      ? ['omit', 'empty', 'whitespace', 'secret']
      : ['omit', 'empty', 'whitespace'];
  return corruptions.map((corruption) => ({ variableName, corruption }));
};

const ALL_BREAKAGES: Breakage[] = [...REQUIRED_VARIABLES, ...FEE_VARIABLES].flatMap(breakagesFor);

// Lowercase only, so a generated secret can never be a substring of a variable name in the error.
const secretValue = fc.stringMatching(/^gen-secret-[a-z0-9]{16,48}$/);

const corruptionPlan = fc.uniqueArray(
  fc.record({ breakage: fc.constantFrom(...ALL_BREAKAGES), secret: secretValue }),
  { minLength: 1, selector: (item) => item.breakage.variableName },
);

interface CorruptionPlanItem {
  readonly breakage: Breakage;
  readonly secret: string;
}

type CorruptionPlan = readonly CorruptionPlanItem[];

const buildEnv = (plan: CorruptionPlan): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...VALID_ENV };
  for (const { breakage, secret } of plan) {
    const { variableName, corruption } = breakage;
    switch (corruption) {
      case 'omit':
        delete env[variableName];
        break;
      case 'empty':
        env[variableName] = '';
        break;
      case 'whitespace':
        env[variableName] = ' \t ';
        break;
      case 'secret':
        env[variableName] = secret;
        break;
    }
  }
  return env;
};

describe('Feature: platform-foundation, Property 6: Missing or invalid configuration fails startup without leaking values', () => {
  it('returns Err naming a broken variable and never leaks a generated value', () => {
    const consoleSpies = [
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'info'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
    ];

    try {
      fc.assert(
        fc.property(corruptionPlan, (plan) => {
          const result = loadConfig(buildEnv(plan));

          expect(result.isErr()).toBe(true);
          const error = result._unsafeUnwrapErr();

          const missing = plan.filter((item) => item.breakage.corruption !== 'secret');
          const invalid = plan.filter((item) => item.breakage.corruption === 'secret');
          // Missing variables are checked before any format validation, so they take precedence.
          if (missing.length > 0) {
            expect(error.kind).toBe('MISSING_ENV_VAR');
            expect(missing.map((item) => item.breakage.variableName)).toContain(error.variableName);
          } else {
            expect(error.kind).toBe('INVALID_ENV_VAR');
            expect(invalid.map((item) => item.breakage.variableName)).toContain(error.variableName);
          }

          expect(Object.keys(error).sort()).toEqual(['kind', 'variableName']);

          const serialized = JSON.stringify(error);
          const message = (error as { readonly message?: unknown }).message ?? '';
          for (const { secret } of plan) {
            expect(serialized).not.toContain(secret);
            expect(String(message)).not.toContain(secret);
          }
        }),
        { numRuns: NUM_RUNS },
      );

      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });
});

const DEFAULT_BASE_FEE_IN_CENTS = 300000;
const DEFAULT_DELIVERY_FEE_IN_CENTS = 800000;

// Unset means undefined, empty or whitespace-only. Valid integers are digit strings within the
// safe integer range, including leading zeros.
const unsetFee = fc.constantFrom<string | undefined>(undefined, '', '   ');
const validFeeText = fc.stringMatching(/^\d{1,15}$/);
const feeSetting = fc.oneof(unsetFee, validFeeText);

const isUnset = (value: string | undefined): value is undefined | string =>
  value === undefined || value.trim() === '';

describe('Feature: platform-foundation, Property 7: Fee defaults apply only when unset', () => {
  it('resolves unset fees to the defaults and valid integer strings to their value', () => {
    fc.assert(
      fc.property(feeSetting, feeSetting, (baseFee, deliveryFee) => {
        const env: Record<string, string | undefined> = {
          ...VALID_ENV,
          BASE_FEE_IN_CENTS: baseFee,
          DELIVERY_FEE_IN_CENTS: deliveryFee,
        };

        const config = loadConfig(env);

        expect(config.isOk()).toBe(true);
        const resolved = config._unsafeUnwrap();
        expect(resolved.baseFeeInCents).toBe(
          isUnset(baseFee) ? DEFAULT_BASE_FEE_IN_CENTS : Number(baseFee),
        );
        expect(resolved.deliveryFeeInCents).toBe(
          isUnset(deliveryFee) ? DEFAULT_DELIVERY_FEE_IN_CENTS : Number(deliveryFee),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
