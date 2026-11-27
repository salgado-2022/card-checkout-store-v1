import * as fc from 'fast-check';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';
import {
  expectNoTransactionWrites,
  postTransaction,
  validIdempotencyKeyArbitrary,
  validTransactionBodyArbitrary,
  type PlainBody,
} from '../../../../test/support/transaction-request-fixtures';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 120_000;

type Location = 'root' | 'delivery' | 'payment';

// Undeclared names shaped like money, identifiers and timestamps. They must never be accepted.
const AMOUNT_SHAPED_NAMES = [
  'amount',
  'amountInCents',
  'totalInCents',
  'subtotalInCents',
  'baseFeeInCents',
  'deliveryFeeInCents',
  'priceInCents',
  'total',
  'price',
  'id',
  'reference',
  'status',
  'createdAt',
] as const;

// Object.prototype names. They are generated on purpose: the validation pipe must reject them
// before class-transformer drops or inherits them (requirement 14.6).
const OBJECT_PROTOTYPE_NAMES = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
] as const;

// Every name the transaction DTOs declare, at any level. A generated name must not collide with one.
const DECLARED_NAMES: ReadonlySet<string> = new Set([
  'productId',
  'quantity',
  'customerId',
  'delivery',
  'payment',
  'acceptanceToken',
  'acceptPersonalAuth',
  'recipientName',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'department',
  'postalCode',
  'cardToken',
  'installments',
  'brand',
  'lastFour',
]);

const locationArbitrary: fc.Arbitrary<Location> = fc.constantFrom<Location>(
  'root',
  'delivery',
  'payment',
);

const unknownNameArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    fc.constantFrom(...AMOUNT_SHAPED_NAMES),
    fc.constantFrom(...OBJECT_PROTOTYPE_NAMES),
    fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,24}$/),
  )
  .filter((name) => !DECLARED_NAMES.has(name));

const unknownValueArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
);

/**
 * Copies `body` and adds an own property `name` at the given level. `defineProperty` keeps names
 * such as `__proto__` as own keys, so the serialized body is exactly what a client could send.
 */
function withUnknownProperty(
  body: PlainBody,
  location: Location,
  name: string,
  value: unknown,
): PlainBody {
  const clone = structuredClone(body);
  const target = location === 'root' ? clone : (clone[location] as PlainBody);
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return clone;
}

// Feature: payments-api, Property 8: Unknown or malformed request bodies are rejected on customers and transactions (transactions part)
describe('Feature: payments-api, Property 8: Unknown or malformed request bodies are rejected on customers and transactions (transactions part)', () => {
  it(
    'rejects a valid transaction body with an undeclared property at any level with 400 VALIDATION_ERROR, no write and no idempotency record',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validTransactionBodyArbitrary,
          validIdempotencyKeyArbitrary,
          locationArbitrary,
          unknownNameArbitrary,
          unknownValueArbitrary,
          async (body: PlainBody, key, location, name, value) => {
            const testApp: TransactionsHttpApp = await createTransactionsHttpApp();
            const beginSpy = jest.spyOn(testApp.idempotency, 'begin');
            try {
              const broken = withUnknownProperty(body, location, name, value);

              const response = await postTransaction(testApp, JSON.stringify(broken), key);

              expect(response.status).toBe(400);
              expect(response.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
              const where = location === 'root' ? name : `${location}.${name}`;
              expect(response.body.details).toContain(`${where}: whitelistValidation`);
              expectNoTransactionWrites(testApp);
              expect(testApp.idempotency.get(key)).toBeUndefined();
              expect(beginSpy).not.toHaveBeenCalled();
            } finally {
              await testApp.app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
