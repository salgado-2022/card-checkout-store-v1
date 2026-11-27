import * as fc from 'fast-check';
import request from 'supertest';
import {
  createRecordingTransactionsApp,
  type RecordingTransactionsApp,
} from '../../../../test/support/recording-transactions-app';
import {
  TRANSACTION_CUSTOMER,
  TRANSACTION_PRODUCT,
} from '../../../../test/support/transactions-http-app';

// Feature: payments-api, Property 14: Created transactions never retain card data or secrets
// Validates: Requirements 5.13, 7.9

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const PATH = '/api/v1/transactions';
const KEY = 'idem-key-0014';

// Card fields that must never reach the API. Each one is rejected by the DTO when sent.
const CARD_FIELD_NAMES = ['cardNumber', 'cvc', 'expiry'] as const;
type CardFieldName = (typeof CARD_FIELD_NAMES)[number];

// Lower-case tokens never occur in the generated ids (Crockford base32 is upper-case) or dates.
const cardTokenArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{15,31}$/);
// Generated, never a literal in the source: the values are only searched for in the output.
const privateKeyArbitrary = fc.stringMatching(/^prv_[a-z][a-z0-9]{20,40}$/);
const integritySecretArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{20,40}$/);
const eventsSecretArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{20,40}$/);
// 16 digits starting with a non-zero digit: a full card number that cannot match ids or amounts.
const cardNumberArbitrary = fc.stringMatching(/^[1-9][0-9]{15}$/);
const cvcArbitrary = fc.stringMatching(/^[0-9]{3}$/);

const caseArbitrary = fc.record({
  cardToken: cardTokenArbitrary,
  privateKey: privateKeyArbitrary,
  integritySecret: integritySecretArbitrary,
  eventsSecret: eventsSecretArbitrary,
  cardNumber: cardNumberArbitrary,
  cvc: cvcArbitrary,
  expiry: fc
    .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 27, max: 40 }))
    .map(([month, year]) => `${String(month).padStart(2, '0')}/${year}`),
  quantity: fc.integer({ min: 1, max: 5 }),
  installments: fc.integer({ min: 1, max: 36 }),
  brand: fc.constantFrom('VISA', 'MASTERCARD'),
});

interface Case {
  readonly cardToken: string;
  readonly privateKey: string;
  readonly integritySecret: string;
  readonly eventsSecret: string;
  readonly cardNumber: string;
  readonly cvc: string;
  readonly expiry: string;
  readonly quantity: number;
  readonly installments: number;
  readonly brand: 'VISA' | 'MASTERCARD';
}

function bodyFor(input: Case, extraPayment: Record<string, string> = {}) {
  return {
    productId: TRANSACTION_PRODUCT.id,
    quantity: input.quantity,
    customerId: TRANSACTION_CUSTOMER.id,
    delivery: {
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 # 2-3',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
    },
    payment: {
      cardToken: input.cardToken,
      installments: input.installments,
      brand: input.brand,
      lastFour: input.cardNumber.slice(-4),
      ...extraPayment,
    },
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  };
}

/** Every value that must never appear in stored items, response bodies or log lines. */
function forbiddenValues(input: Case): string[] {
  return [
    input.cardToken,
    input.cardNumber,
    input.privateKey,
    input.integritySecret,
    input.eventsSecret,
  ];
}

// Key names of card fields are checked separately: a 3-digit CVC is too short to search for safely.
function containsCardFieldKey(serialized: string): boolean {
  return CARD_FIELD_NAMES.some((name) => new RegExp(`"${name}"\\s*:`).test(serialized));
}

async function runValidCase(input: Case): Promise<void> {
  const testApp: RecordingTransactionsApp = await createRecordingTransactionsApp();
  try {
    const response = await request(testApp.app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', KEY)
      .send(bodyFor(input));
    expect(response.status).toBe(201);

    // Everything the application stored, every response body and every log line.
    // The gateway request is excluded: it carries the token to the provider by design and is never stored.
    const stored = testApp.steps.steps.filter((entry) => entry.step !== 'gateway.create');
    const serialized = [
      JSON.stringify(stored),
      response.text,
      JSON.stringify(testApp.appLogs.entries),
      JSON.stringify(testApp.httpLogs),
    ].join('\n');

    for (const value of forbiddenValues(input)) {
      expect(serialized).not.toContain(value);
    }
    expect(containsCardFieldKey(serialized)).toBe(false);
  } finally {
    await testApp.app.close();
  }
}

async function runCardFieldCase(input: Case, field: CardFieldName): Promise<void> {
  const testApp: RecordingTransactionsApp = await createRecordingTransactionsApp();
  try {
    const value =
      field === 'cardNumber' ? input.cardNumber : field === 'cvc' ? input.cvc : input.expiry;
    const response = await request(testApp.app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', KEY)
      .send(bodyFor(input, { [field]: value }));

    // The DTO rejects the card field before any use case runs: nothing is stored or logged with it.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.text).not.toContain(input.cardNumber);
    expect(testApp.steps.steps).toEqual([]);
    expect(testApp.transactions.count()).toBe(0);
    expect(testApp.gateway.requests).toEqual([]);
  } finally {
    await testApp.app.close();
  }
}

describe('Property 14: Created transactions never retain card data or secrets', () => {
  it(
    'keeps the card token, card number and secrets out of stored items, responses and logs',
    async () => {
      await fc.assert(fc.asyncProperty(caseArbitrary, runValidCase), { numRuns: NUM_RUNS });
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'rejects card number, CVC and expiry sent to the API with 400 and no write',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, fc.constantFrom(...CARD_FIELD_NAMES), runCardFieldCase),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
