import { err, errAsync, ok, okAsync, type Result } from 'neverthrow';
import type { Product } from '../../domain/entities';
import type { TransactionStatus } from '../../domain/transaction-status';
import { FakeApplicationLogger } from '../../../test/support/fake-application-logger';
import { FakeClock } from '../../../test/support/fake-clock';
import { FakeIdGenerator } from '../../../test/support/fake-id-generator';
import { FakePaymentGateway } from '../../../test/support/fake-payment-gateway';
import { InMemoryCustomerRepository } from '../../../test/support/in-memory-customer-repository';
import { InMemoryDeliveryRepository } from '../../../test/support/in-memory-delivery-repository';
import { InMemoryIdempotencyRepository } from '../../../test/support/in-memory-idempotency-repository';
import { InMemoryProductRepository } from '../../../test/support/in-memory-product-repository';
import { InMemoryTransactionRepository } from '../../../test/support/in-memory-transaction-repository';
import type { PaymentGatewayError, RepositoryError } from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { PaymentCreateResponse } from '../ports/payment-gateway';
import { requestHash, type JsonValue } from '../request-hash';
import {
  CreateTransaction,
  PAYMENT_PROVIDER_ERROR_BODY,
  type CreateTransactionOutput,
  type CreateTransactionRequest,
  type TransactionResponseBody,
} from './create-transaction';
import { FinalizeTransaction } from './finalize-transaction';

const KEY = 'idem-key-0001';
const CARD_TOKEN = 'tok_test_fake';
const ACCEPTANCE_TOKEN = 'acc_test_fake';
const PERSONAL_AUTH_TOKEN = 'auth_test_fake';
const UNIT_PRICE = 12_000_000;
const TOTAL = 2 * UNIT_PRICE + 300_000 + 800_000;
// The fake id generator is deterministic: the first ULID it returns becomes the Reference.
const REFERENCE = `ORD-${new FakeIdGenerator().ulid()}`;
const REPOSITORY_FAILURE: RepositoryError = { kind: 'REPOSITORY_ERROR', reason: 'Boom' };

const PRODUCT: Product = {
  id: 'prod-1',
  sku: 'SKU-1',
  name: 'Product',
  description: 'Description',
  imageUrl: 'https://cdn.example/p.webp',
  priceInCents: UNIT_PRICE,
  currency: 'COP',
  stock: 10,
};

function buildRequest(overrides: Partial<CreateTransactionRequest> = {}): CreateTransactionRequest {
  return {
    productId: 'prod-1',
    quantity: 2,
    customerId: 'cust-1',
    delivery: {
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 2-3',
      city: 'Bogota',
      department: 'Bogotá D.C.',
    },
    payment: { cardToken: CARD_TOKEN, installments: 3, brand: 'VISA', lastFour: '4242' },
    acceptanceToken: ACCEPTANCE_TOKEN,
    acceptPersonalAuth: PERSONAL_AUTH_TOKEN,
    ...overrides,
  };
}

function providerAnswer(
  status: TransactionStatus,
  overrides: Partial<PaymentCreateResponse> = {},
): Result<PaymentCreateResponse, PaymentGatewayError> {
  return ok({
    externalId: 'ext-1',
    status,
    message: null,
    amountInCents: TOTAL,
    currency: 'COP',
    reference: REFERENCE,
    ...overrides,
  });
}

const rejected = (
  providerMessage: string,
  afterTransientFailure: boolean,
): Result<PaymentCreateResponse, PaymentGatewayError> =>
  err({ kind: 'REJECTED', providerMessage, afterTransientFailure });

const unavailable = (): Result<PaymentCreateResponse, PaymentGatewayError> =>
  err({ kind: 'UNAVAILABLE', reason: 'timeout' });

interface SetupOptions {
  readonly stock?: number;
  readonly products?: readonly Product[];
  readonly idempotency?: (clock: Clock) => InMemoryIdempotencyRepository;
  readonly ids?: IdGenerator;
}

function setup(options: SetupOptions = {}) {
  const clock = new FakeClock('2026-05-01T10:00:00.000Z');
  const products = new InMemoryProductRepository(
    options.products ?? [{ ...PRODUCT, stock: options.stock ?? 10 }],
  );
  const customers = new InMemoryCustomerRepository([
    {
      id: 'cust-1',
      email: 'ana@example.com',
      fullName: 'Ana Perez',
      phone: '3001234567',
      documentType: 'CC',
      documentNumber: '1234567890',
      createdAt: '2026-04-01T10:00:00.000Z',
      updatedAt: '2026-04-01T10:00:00.000Z',
    },
  ]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  const idempotency = options.idempotency?.(clock) ?? new InMemoryIdempotencyRepository(clock);
  const gateway = new FakePaymentGateway();
  const logger = new FakeApplicationLogger();
  const finalize = new FinalizeTransaction(transactions, logger, clock);
  const useCase = new CreateTransaction(
    idempotency,
    products,
    customers,
    transactions,
    deliveries,
    gateway,
    finalize,
    { baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 },
    options.ids ?? new FakeIdGenerator(),
    clock,
    logger,
  );
  return {
    useCase,
    clock,
    products,
    customers,
    deliveries,
    transactions,
    idempotency,
    gateway,
    logger,
  };
}

type Setup = ReturnType<typeof setup>;

const bodyOf = (output: CreateTransactionOutput): TransactionResponseBody =>
  output.body as TransactionResponseBody;

const hashOf = (request: CreateTransactionRequest): string =>
  requestHash(JSON.parse(JSON.stringify(request)) as JsonValue);

async function run(
  s: Setup,
  request: CreateTransactionRequest = buildRequest(),
  ...key: [(string | undefined)?]
) {
  return s.useCase.execute({
    idempotencyKey: key.length === 0 ? KEY : key[0],
    request,
  });
}

/** Everything the API stored or logged for the purchase, as one string, to look for leaks. */
async function everythingWritten(s: Setup, output: CreateTransactionOutput): Promise<string> {
  const transaction = (await s.transactions.findByReference(REFERENCE))._unsafeUnwrap();
  const delivery = transaction === null ? undefined : s.deliveries.get(transaction.deliveryId);
  return JSON.stringify([
    transaction,
    delivery,
    s.idempotency.get(KEY),
    output.body,
    s.logger.entries,
  ]);
}

describe('CreateTransaction', () => {
  describe('Idempotency-Key validation', () => {
    it.each([undefined, ''])(
      'rejects the key %j with MISSING_IDEMPOTENCY_KEY and writes nothing',
      async (key) => {
        const s = setup();
        const result = await run(s, buildRequest(), key);
        expect(result._unsafeUnwrapErr()).toEqual({ kind: 'MISSING_IDEMPOTENCY_KEY' });
        expect(s.deliveries.count()).toBe(0);
        expect(s.transactions.count()).toBe(0);
        expect(s.gateway.callLog).toEqual([]);
      },
    );

    it.each(['short', 'has space 12345', 'bad/chars-0001', 'x'.repeat(129), 'ñandú-0001'])(
      'rejects the malformed key %j with VALIDATION_ERROR and writes nothing',
      async (key) => {
        const s = setup();
        const result = await run(s, buildRequest(), key);
        expect(result._unsafeUnwrapErr()).toMatchObject({
          kind: 'VALIDATION_ERROR',
          details: [{ field: 'Idempotency-Key' }],
        });
        expect(s.idempotency.get(key)).toBeUndefined();
        expect(s.transactions.count()).toBe(0);
        expect(s.gateway.callLog).toEqual([]);
      },
    );

    it.each(['abcdefgh', 'A.b_c-1234', 'x'.repeat(128)])('accepts the key %j', async (key) => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const result = await run(s, buildRequest(), key);
      expect(result._unsafeUnwrap().statusCode).toBe(201);
    });
  });

  describe('idempotency gate', () => {
    it('begins with the key and the request hash before any other write', async () => {
      const s = setup();
      const request = buildRequest();
      const begin = jest.spyOn(s.idempotency, 'begin');
      const createDelivery = jest.spyOn(s.deliveries, 'create');
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      await run(s, request);
      expect(begin).toHaveBeenCalledWith(KEY, hashOf(request), s.clock.now());
      expect(begin.mock.invocationCallOrder[0]).toBeLessThan(
        createDelivery.mock.invocationCallOrder[0] as number,
      );
    });

    it('answers IDEMPOTENCY_KEY_REUSED for the same key with a different body, with no new write', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      await run(s, buildRequest({ quantity: 2 }));
      const result = await run(s, buildRequest({ quantity: 3 }));
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'IDEMPOTENCY_KEY_REUSED' });
      expect(s.transactions.count()).toBe(1);
      expect(s.gateway.callCount('create')).toBe(1);
    });

    it('answers IDEMPOTENCY_KEY_IN_PROGRESS while the first request is fresh, with no provider call', async () => {
      const s = setup();
      const request = buildRequest();
      await s.idempotency.begin(KEY, hashOf(request), s.clock.now());
      s.clock.advance(5_000);
      const result = await run(s, request);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
      expect(s.gateway.callLog).toEqual([]);
      expect(s.transactions.count()).toBe(0);
    });

    it('two simultaneous requests with one key create one transaction and one charge', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const [first, second] = await Promise.all([run(s), run(s)]);
      expect(first._unsafeUnwrap().statusCode).toBe(201);
      expect(second._unsafeUnwrapErr()).toEqual({ kind: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
      expect(s.transactions.count()).toBe(1);
      expect(s.gateway.callCount('create')).toBe(1);
    });

    it('replays a completed 201 as 200 with the same body, no new transaction and no provider call', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      const first = (await run(s))._unsafeUnwrap();
      const replay = (await run(s))._unsafeUnwrap();
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(s.transactions.count()).toBe(1);
      expect(s.deliveries.count()).toBe(1);
      expect(s.gateway.callCount('create')).toBe(1);
      expect(s.products.stockOf('prod-1')).toBe(8);
    });

    it('treats a body that differs only in key order as the same request', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const request = buildRequest();
      await run(s, request);
      const reordered: CreateTransactionRequest = {
        acceptPersonalAuth: request.acceptPersonalAuth,
        acceptanceToken: request.acceptanceToken,
        payment: {
          lastFour: request.payment.lastFour,
          brand: request.payment.brand,
          installments: request.payment.installments,
          cardToken: request.payment.cardToken,
        },
        delivery: {
          department: request.delivery.department,
          city: request.delivery.city,
          addressLine1: request.delivery.addressLine1,
          phone: request.delivery.phone,
          recipientName: request.delivery.recipientName,
        },
        customerId: request.customerId,
        quantity: request.quantity,
        productId: request.productId,
      };
      const replay = (await run(s, reordered))._unsafeUnwrap();
      expect(replay.statusCode).toBe(200);
      expect(s.gateway.callCount('create')).toBe(1);
    });

    it('treats an absent optional field and an undefined one as the same request', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const request = buildRequest();
      await run(s, request);
      const withUndefined = buildRequest({
        delivery: { ...request.delivery, addressLine2: undefined },
      });
      const replay = (await run(s, withUndefined))._unsafeUnwrap();
      expect(replay.statusCode).toBe(200);
    });

    it('replays a stored 502 with its status and body unchanged', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(rejected('PROVIDER_REJECTED', false));
      const first = (await run(s))._unsafeUnwrap();
      const replay = (await run(s))._unsafeUnwrap();
      expect(replay.statusCode).toBe(502);
      expect(replay.body).toEqual(first.body);
      expect(s.gateway.callCount('create')).toBe(1);
    });

    describe('stale record', () => {
      const STALE_MS = 26_000;

      it('with a transaction id answers 200 with the current state and no provider call', async () => {
        const s = setup();
        const request = buildRequest();
        s.gateway.script.create.enqueue(providerAnswer('PENDING'));
        const first = bodyOf((await run(s))._unsafeUnwrap());
        // Simulate an invocation that died before `complete`: the record is IN_PROGRESS again.
        await s.idempotency.release(KEY);
        await s.idempotency.begin(KEY, hashOf(request), s.clock.now());
        await s.idempotency.attachTransactionId(KEY, first.id);
        s.clock.advance(STALE_MS);
        const stored = (await s.transactions.findById(first.id))._unsafeUnwrap();
        await s.transactions.finalize({
          transactionId: first.id,
          deliveryId: first.deliveryId,
          productId: 'prod-1',
          quantity: 2,
          status: 'DECLINED',
          deliveryStatus: 'CANCELLED',
          at: s.clock.now().toISOString(),
        });

        const result = (await run(s, request))._unsafeUnwrap();

        expect(stored?.status).toBe('PENDING');
        expect(result.statusCode).toBe(200);
        expect(bodyOf(result)).toMatchObject({
          id: first.id,
          reference: REFERENCE,
          status: 'DECLINED',
        });
        expect(s.gateway.callCount('create')).toBe(1);
        expect(s.transactions.count()).toBe(1);
      });

      it('with a transaction id that no longer exists answers a repository error', async () => {
        const s = setup();
        const request = buildRequest();
        await s.idempotency.begin(KEY, hashOf(request), s.clock.now());
        await s.idempotency.attachTransactionId(KEY, 'missing-txn');
        s.clock.advance(STALE_MS);
        const result = await run(s, request);
        expect(result._unsafeUnwrapErr()).toEqual({
          kind: 'REPOSITORY_ERROR',
          reason: 'IdempotencyTransactionMissing',
        });
        expect(s.gateway.callLog).toEqual([]);
      });

      it('without a transaction id takes the record over and processes the request', async () => {
        const s = setup();
        const request = buildRequest();
        await s.idempotency.begin(KEY, hashOf(request), s.clock.now());
        s.clock.advance(STALE_MS);
        s.gateway.script.create.enqueue(providerAnswer('PENDING'));
        const result = (await run(s, request))._unsafeUnwrap();
        expect(result.statusCode).toBe(201);
        expect(s.gateway.callCount('create')).toBe(1);
        expect(s.idempotency.get(KEY)).toMatchObject({ state: 'COMPLETED', statusCode: 201 });
      });

      describe('when another invocation wins the takeover', () => {
        class LostRaceIdempotency extends InMemoryIdempotencyRepository {
          takeOverCalls = 0;

          constructor(
            clock: Clock,
            private readonly winnerCompletes: boolean,
          ) {
            super(clock);
          }

          override takeOver(key: string) {
            this.takeOverCalls += 1;
            const lost = okAsync<'taken' | 'lost_race', RepositoryError>('lost_race');
            return this.winnerCompletes
              ? this.complete(key, 201, { id: 'winner-body' }).andThen(() => lost)
              : lost;
          }
        }

        it('looks again once and replays what the winner stored', async () => {
          const winner = { current: undefined as LostRaceIdempotency | undefined };
          const s = setup({
            idempotency: (clock) => (winner.current = new LostRaceIdempotency(clock, true)),
          });
          const request = buildRequest();
          await s.idempotency.begin(KEY, hashOf(request), s.clock.now());
          s.clock.advance(STALE_MS);
          const result = (await run(s, request))._unsafeUnwrap();
          expect(result).toEqual({ statusCode: 200, body: { id: 'winner-body' } });
          expect(winner.current?.takeOverCalls).toBe(1);
          expect(s.gateway.callLog).toEqual([]);
          expect(s.transactions.count()).toBe(0);
        });

        it('looks again once and then reports the request as in progress', async () => {
          const loser = { current: undefined as LostRaceIdempotency | undefined };
          const s = setup({
            idempotency: (clock) => (loser.current = new LostRaceIdempotency(clock, false)),
          });
          const request = buildRequest();
          await s.idempotency.begin(KEY, hashOf(request), s.clock.now());
          s.clock.advance(STALE_MS);
          const result = await run(s, request);
          expect(result._unsafeUnwrapErr()).toEqual({ kind: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
          expect(loser.current?.takeOverCalls).toBe(2);
          expect(s.gateway.callLog).toEqual([]);
        });
      });
    });

    it('propagates a failure of the idempotency store before anything is written', async () => {
      const s = setup();
      s.idempotency.failure = REPOSITORY_FAILURE;
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
      expect(s.transactions.count()).toBe(0);
      expect(s.gateway.callLog).toEqual([]);
    });
  });

  describe('validation before any write', () => {
    const expectNothingWritten = (s: Setup) => {
      expect(s.deliveries.count()).toBe(0);
      expect(s.transactions.count()).toBe(0);
      expect(s.gateway.callLog).toEqual([]);
      expect(s.products.stockOf('prod-1')).toBe(10);
      // Requirement 6.11: the record is deleted so the key can be used again.
      expect(s.idempotency.get(KEY)).toBeUndefined();
    };

    it('unknown product: PRODUCT_NOT_FOUND', async () => {
      const s = setup();
      const result = await run(s, buildRequest({ productId: 'nope' }));
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'PRODUCT_NOT_FOUND' });
      expectNothingWritten(s);
    });

    it('unknown customer: CUSTOMER_NOT_FOUND', async () => {
      const s = setup();
      const result = await run(s, buildRequest({ customerId: 'nope' }));
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'CUSTOMER_NOT_FOUND' });
      expectNothingWritten(s);
    });

    it('stock below the quantity: INSUFFICIENT_STOCK states the available units', async () => {
      const s = setup({ stock: 1 });
      const result = await run(s, buildRequest({ quantity: 2 }));
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INSUFFICIENT_STOCK', available: 1 });
      expect(s.deliveries.count()).toBe(0);
      expect(s.transactions.count()).toBe(0);
      expect(s.gateway.callLog).toEqual([]);
      expect(s.products.stockOf('prod-1')).toBe(1);
      expect(s.idempotency.get(KEY)).toBeUndefined();
    });

    it('stock equal to the quantity is enough', async () => {
      const s = setup({ stock: 2 });
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const result = await run(s, buildRequest({ quantity: 2 }));
      expect(result._unsafeUnwrap().statusCode).toBe(201);
    });

    it('a product price that is not an integer number of cents: INVALID_AMOUNTS', async () => {
      const s = setup({ products: [{ ...PRODUCT, priceInCents: 1.5 }] });
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_AMOUNTS' });
      expectNothingWritten(s);
    });

    it('an id generator that yields an invalid ULID: INVALID_REFERENCE', async () => {
      const s = setup({ ids: { ulid: () => 'not-a-ulid' } });
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'INVALID_REFERENCE' });
      expectNothingWritten(s);
    });

    it('a failing product repository: the repository error, and the key is released', async () => {
      const s = setup();
      s.products.failure = REPOSITORY_FAILURE;
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
      expect(s.idempotency.get(KEY)).toBeUndefined();
      expect(s.transactions.count()).toBe(0);
    });

    it('a failing customer repository: the repository error, and the key is released', async () => {
      const s = setup();
      s.customers.failure = REPOSITORY_FAILURE;
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
      expect(s.idempotency.get(KEY)).toBeUndefined();
    });

    it('the same key works again once the validation failure is fixed', async () => {
      const s = setup();
      await run(s, buildRequest({ productId: 'nope' }));
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const result = await run(s, buildRequest({ productId: 'nope' }));
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'PRODUCT_NOT_FOUND' });
      const fixed = await run(s, buildRequest());
      expect(fixed._unsafeUnwrap().statusCode).toBe(201);
    });

    it('returns the business error and logs a warning when the key cannot be released', async () => {
      const s = setup();
      jest
        .spyOn(s.idempotency, 'release')
        .mockReturnValue(
          errAsync<undefined, RepositoryError>({ kind: 'REPOSITORY_ERROR', reason: 'Gone' }),
        );
      const result = await run(s, buildRequest({ productId: 'nope' }));
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'PRODUCT_NOT_FOUND' });
      expect(s.logger.at('warn')).toEqual([
        expect.objectContaining({ fields: { reason: 'Gone' } }),
      ]);
    });
  });

  describe('PENDING persistence', () => {
    it('stores a PENDING Delivery and a PENDING Transaction with the computed amounts and the snapshot', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const output = (await run(s))._unsafeUnwrap();
      const body = bodyOf(output);
      const transaction = s.transactions.get(body.id);
      const delivery = s.deliveries.get(body.deliveryId);

      expect(transaction).toMatchObject({
        id: body.id,
        reference: REFERENCE,
        productId: 'prod-1',
        quantity: 2,
        customerId: 'cust-1',
        deliveryId: body.deliveryId,
        unitPriceInCents: UNIT_PRICE,
        subtotalInCents: 24_000_000,
        baseFeeInCents: 300_000,
        deliveryFeeInCents: 800_000,
        totalInCents: 25_100_000,
        currency: 'COP',
        installments: 3,
        cardBrand: 'VISA',
        cardLastFour: '4242',
        createdAt: '2026-05-01T10:00:00.000Z',
      });
      expect(delivery).toMatchObject({
        id: body.deliveryId,
        transactionId: body.id,
        status: 'PENDING',
        productId: 'prod-1',
        quantity: 2,
        recipientName: 'Ana Perez',
        phone: '3001234567',
        addressLine1: 'Calle 1 2-3',
        city: 'Bogota',
        department: 'Bogotá D.C.',
      });
      expect(delivery).not.toHaveProperty('addressLine2');
      expect(delivery).not.toHaveProperty('postalCode');
      expect(body.reference).toMatch(/^ORD-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    });

    it('stores the optional delivery fields when they are sent', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const request = buildRequest({
        delivery: {
          ...buildRequest().delivery,
          addressLine2: 'Apto 501',
          postalCode: '110111',
        },
      });
      const body = bodyOf((await run(s, request))._unsafeUnwrap());
      expect(s.deliveries.get(body.deliveryId)).toMatchObject({
        addressLine2: 'Apto 501',
        postalCode: '110111',
      });
    });

    it('computes the total from the configured fees: 2 × 120,000 + 3,000 + 8,000 = 251,000 COP', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const body = bodyOf((await run(s))._unsafeUnwrap());
      expect(body.amounts).toEqual({
        currency: 'COP',
        subtotalInCents: 24_000_000,
        baseFeeInCents: 300_000,
        deliveryFeeInCents: 800_000,
        totalInCents: 25_100_000,
      });
    });

    it('persists both rows and attaches the transaction id before the first provider call', async () => {
      const s = setup();
      const seen: Array<{
        deliveries: number;
        transactions: number;
        attached: string | null | undefined;
      }> = [];
      const original = s.gateway.create.bind(s.gateway);
      jest.spyOn(s.gateway, 'create').mockImplementation((request) => {
        seen.push({
          deliveries: s.deliveries.count(),
          transactions: s.transactions.count(),
          attached: s.idempotency.get(KEY)?.transactionId,
        });
        return original(request);
      });
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const body = bodyOf((await run(s))._unsafeUnwrap());
      expect(seen).toEqual([{ deliveries: 1, transactions: 1, attached: body.id }]);
    });

    it('creates the Delivery before the Transaction', async () => {
      const s = setup();
      const createDelivery = jest.spyOn(s.deliveries, 'create');
      const createTransaction = jest.spyOn(s.transactions, 'create');
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      await run(s);
      expect(createDelivery.mock.invocationCallOrder[0]).toBeLessThan(
        createTransaction.mock.invocationCallOrder[0] as number,
      );
    });

    it('sends the provider request built from stored values, ignoring anything client-side', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      await run(s);
      expect(s.gateway.script.create.calls).toEqual([
        [
          {
            reference: REFERENCE,
            amountInCents: TOTAL,
            currency: 'COP',
            customerEmail: 'ana@example.com',
            acceptanceToken: ACCEPTANCE_TOKEN,
            acceptPersonalAuth: PERSONAL_AUTH_TOKEN,
            cardToken: CARD_TOKEN,
            installments: 3,
          },
        ],
      ]);
    });

    it('keeps the stock unchanged while the Transaction is PENDING', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      await run(s);
      expect(s.products.stockOf('prod-1')).toBe(10);
    });

    it('does not release the key and calls no provider when the Delivery cannot be created', async () => {
      const s = setup();
      s.deliveries.failure = REPOSITORY_FAILURE;
      const release = jest.spyOn(s.idempotency, 'release');
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
      expect(release).not.toHaveBeenCalled();
      expect(s.idempotency.get(KEY)).toMatchObject({ state: 'IN_PROGRESS' });
      expect(s.transactions.count()).toBe(0);
      expect(s.gateway.callLog).toEqual([]);
    });

    it('does not release the key and calls no provider when the Transaction cannot be created', async () => {
      const s = setup();
      s.transactions.failure = REPOSITORY_FAILURE;
      const release = jest.spyOn(s.idempotency, 'release');
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
      expect(release).not.toHaveBeenCalled();
      expect(s.idempotency.get(KEY)).toMatchObject({ state: 'IN_PROGRESS' });
      expect(s.gateway.callLog).toEqual([]);
    });

    it('calls no provider when the transaction id cannot be attached to the record', async () => {
      const s = setup();
      jest
        .spyOn(s.idempotency, 'attachTransactionId')
        .mockReturnValue(errAsync<void, RepositoryError>(REPOSITORY_FAILURE));
      const release = jest.spyOn(s.idempotency, 'release');
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
      expect(release).not.toHaveBeenCalled();
      expect(s.gateway.callLog).toEqual([]);
    });
  });

  describe('provider outcomes', () => {
    it('PENDING: 201 PENDING, External_Id stored, Delivery PENDING, stock unchanged', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const output = (await run(s))._unsafeUnwrap();
      const body = bodyOf(output);
      expect(output.statusCode).toBe(201);
      expect(body.status).toBe('PENDING');
      expect(s.transactions.get(body.id)).toMatchObject({ status: 'PENDING', externalId: 'ext-1' });
      expect(s.deliveries.get(body.deliveryId)?.status).toBe('PENDING');
      expect(s.products.stockOf('prod-1')).toBe(10);
      expect(s.gateway.callCount('findByReference')).toBe(0);
    });

    it('APPROVED: 201 APPROVED, Delivery ASSIGNED, stock decremented', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      const output = (await run(s))._unsafeUnwrap();
      const body = bodyOf(output);
      expect(output.statusCode).toBe(201);
      expect(body.status).toBe('APPROVED');
      expect(s.transactions.get(body.id)).toMatchObject({
        status: 'APPROVED',
        externalId: 'ext-1',
        finalizedAt: '2026-05-01T10:00:00.000Z',
      });
      expect(s.transactions.get(body.id)).not.toHaveProperty('statusReason');
      expect(s.deliveries.get(body.deliveryId)?.status).toBe('ASSIGNED');
      expect(s.products.stockOf('prod-1')).toBe(8);
      expect(s.logger.entries).toEqual([]);
    });

    it('APPROVED with a provider message never stores it as a reason', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('APPROVED', { message: 'Aprobada' }));
      const body = bodyOf((await run(s))._unsafeUnwrap());
      expect(s.transactions.get(body.id)).not.toHaveProperty('statusReason');
    });

    it('APPROVED with no stock left at finalization: 201 APPROVED, Delivery BACKORDER and an alert', async () => {
      const s = setup();
      const original = s.gateway.create.bind(s.gateway);
      jest.spyOn(s.gateway, 'create').mockImplementation((request) => {
        s.products.decrementIfAvailable('prod-1', 9);
        return original(request);
      });
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      const body = bodyOf((await run(s))._unsafeUnwrap());
      expect(body.status).toBe('APPROVED');
      expect(s.deliveries.get(body.deliveryId)?.status).toBe('BACKORDER');
      expect(s.products.stockOf('prod-1')).toBe(1);
      expect(s.logger.at('alert')).toEqual([
        expect.objectContaining({ fields: { reference: REFERENCE, productId: 'prod-1' } }),
      ]);
    });

    describe.each<TransactionStatus>(['DECLINED', 'VOIDED', 'ERROR'])('%s', (status) => {
      it('finalizes with the cleaned provider message, cancels the Delivery and keeps the stock', async () => {
        const s = setup();
        s.gateway.script.create.enqueue(
          providerAnswer(status, { message: '  Fondos\u0000 insuficientes\r\n ' }),
        );
        const output = (await run(s))._unsafeUnwrap();
        const body = bodyOf(output);
        expect(output.statusCode).toBe(201);
        expect(body.status).toBe(status);
        expect(s.transactions.get(body.id)).toMatchObject({
          status,
          statusReason: 'Fondos insuficientes',
        });
        expect(s.deliveries.get(body.deliveryId)?.status).toBe('CANCELLED');
        expect(s.products.stockOf('prod-1')).toBe(10);
      });

      it('omits the reason when the provider message is empty after cleaning', async () => {
        const s = setup();
        s.gateway.script.create.enqueue(providerAnswer(status, { message: ' \u0000\n ' }));
        const body = bodyOf((await run(s))._unsafeUnwrap());
        expect(s.transactions.get(body.id)).not.toHaveProperty('statusReason');
      });

      it('omits the reason when the provider sends no message', async () => {
        const s = setup();
        s.gateway.script.create.enqueue(providerAnswer(status, { message: null }));
        const body = bodyOf((await run(s))._unsafeUnwrap());
        expect(s.transactions.get(body.id)).not.toHaveProperty('statusReason');
      });
    });

    it('DECLINED: a long message with control characters is stored cut to 200 characters and never logged', async () => {
      const s = setup();
      const message = `\u0007  Tarjeta rechazada\u0000 ${'x'.repeat(400)} SENSITIVE-TAIL`;
      s.gateway.script.create.enqueue(providerAnswer('DECLINED', { message }));
      const body = bodyOf((await run(s))._unsafeUnwrap());
      const reason = s.transactions.get(body.id)?.statusReason as string;
      expect(reason).toHaveLength(200);
      expect(reason.startsWith('Tarjeta rechazada x')).toBe(true);
      expect(reason).not.toMatch(/\p{Cc}/u);
      expect(reason).not.toContain('SENSITIVE-TAIL');
      expect(JSON.stringify(s.logger.entries)).not.toContain('Tarjeta rechazada');
      expect(JSON.stringify(body)).not.toContain('Tarjeta rechazada');
    });

    describe.each([
      ['amountInCents', { amountInCents: TOTAL - 1 }],
      ['currency', { currency: 'USD' }],
      ['reference', { reference: 'ORD-OTHER-REFERENCE' }],
    ] as const)('an APPROVED report with a different %s', (field, override) => {
      it('ends ERROR AMOUNT_MISMATCH, Delivery CANCELLED, stock unchanged, with an alert', async () => {
        const s = setup();
        s.gateway.script.create.enqueue(providerAnswer('APPROVED', override));
        const output = (await run(s))._unsafeUnwrap();
        const body = bodyOf(output);
        expect(output.statusCode).toBe(201);
        expect(body.status).toBe('ERROR');
        expect(s.transactions.get(body.id)).toMatchObject({
          status: 'ERROR',
          statusReason: 'AMOUNT_MISMATCH',
        });
        expect(s.deliveries.get(body.deliveryId)?.status).toBe('CANCELLED');
        expect(s.products.stockOf('prod-1')).toBe(10);
        expect(s.logger.at('alert')).toEqual([
          expect.objectContaining({ fields: { reference: REFERENCE, fields: field } }),
        ]);
      });
    });

    it('a mismatch overrides a DECLINED report and its message', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(
        providerAnswer('DECLINED', { amountInCents: 1, message: 'Rechazada por el banco' }),
      );
      const body = bodyOf((await run(s))._unsafeUnwrap());
      expect(s.transactions.get(body.id)).toMatchObject({
        status: 'ERROR',
        statusReason: 'AMOUNT_MISMATCH',
      });
      expect(JSON.stringify(s.logger.entries)).not.toContain('Rechazada por el banco');
    });

    it('stays 201 PENDING when the External_Id cannot be stored, and warns without payment data', async () => {
      const s = setup();
      jest
        .spyOn(s.transactions, 'setExternalId')
        .mockReturnValue(
          errAsync<void, RepositoryError>({ kind: 'REPOSITORY_ERROR', reason: 'Throttled' }),
        );
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      const output = (await run(s))._unsafeUnwrap();
      expect(output.statusCode).toBe(201);
      expect(bodyOf(output).status).toBe('PENDING');
      expect(s.logger.at('warn')).toEqual([
        expect.objectContaining({ fields: { reference: REFERENCE, reason: 'Throttled' } }),
      ]);
      expect(s.products.stockOf('prod-1')).toBe(10);
    });

    it('stays 201 PENDING when finalization fails after the provider answered a final status', async () => {
      const s = setup();
      jest
        .spyOn(s.transactions, 'finalize')
        .mockReturnValue(
          errAsync<never, RepositoryError>({ kind: 'REPOSITORY_ERROR', reason: 'Throttled' }),
        );
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      const output = (await run(s))._unsafeUnwrap();
      expect(output.statusCode).toBe(201);
      expect(bodyOf(output).status).toBe('PENDING');
      expect(s.logger.at('warn')).toHaveLength(1);
      expect(s.products.stockOf('prod-1')).toBe(10);
    });
  });

  describe('provider failures', () => {
    it('a 4xx on the first attempt: ERROR with the reason code, Delivery CANCELLED, stock unchanged, 502', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(rejected('INPUT_VALIDATION_ERROR', false));
      const output = (await run(s))._unsafeUnwrap();
      const transaction = (await s.transactions.findByReference(REFERENCE))._unsafeUnwrap();
      expect(output).toEqual({ statusCode: 502, body: PAYMENT_PROVIDER_ERROR_BODY });
      expect(transaction).toMatchObject({
        status: 'ERROR',
        statusReason: 'INPUT_VALIDATION_ERROR',
      });
      expect(transaction).not.toHaveProperty('externalId');
      expect(s.deliveries.get(transaction?.deliveryId as string)?.status).toBe('CANCELLED');
      expect(s.products.stockOf('prod-1')).toBe(10);
      expect(s.gateway.callCount('create')).toBe(1);
      expect(s.gateway.callCount('findByReference')).toBe(0);
    });

    it('an expired acceptance token (4xx): ERROR, Delivery CANCELLED and 502', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(rejected('PROVIDER_REJECTED', false));
      const output = (await run(s))._unsafeUnwrap();
      const transaction = (await s.transactions.findByReference(REFERENCE))._unsafeUnwrap();
      expect(output.statusCode).toBe(502);
      expect(output.body).toEqual({
        statusCode: 502,
        code: 'PAYMENT_PROVIDER_ERROR',
        message: 'The payment provider could not process the request.',
        details: [],
      });
      expect(transaction?.status).toBe('ERROR');
      expect(s.deliveries.get(transaction?.deliveryId as string)?.status).toBe('CANCELLED');
    });

    it('stores the 502 response in the idempotency record', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(rejected('PROVIDER_REJECTED', false));
      const output = (await run(s))._unsafeUnwrap();
      expect(s.idempotency.get(KEY)).toMatchObject({
        state: 'COMPLETED',
        statusCode: 502,
        body: output.body,
      });
    });

    it('a 4xx on the retry after a transient failure: 201 PENDING, no External_Id, Delivery PENDING, no reconciliation', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(rejected('PROVIDER_REJECTED', true));
      const output = (await run(s))._unsafeUnwrap();
      const body = bodyOf(output);
      expect(output.statusCode).toBe(201);
      expect(body.status).toBe('PENDING');
      expect(s.transactions.get(body.id)).not.toHaveProperty('externalId');
      expect(s.deliveries.get(body.deliveryId)?.status).toBe('PENDING');
      expect(s.products.stockOf('prod-1')).toBe(10);
      expect(s.gateway.callLog).toEqual(['create']);
      expect(s.logger.at('warn')).toEqual([
        expect.objectContaining({ fields: { reference: REFERENCE, failure: 'REJECTED' } }),
      ]);
    });

    it.each([
      ['UNAVAILABLE after the retry', unavailable()],
      [
        'INVALID_RESPONSE',
        err({ kind: 'INVALID_RESPONSE', reason: 'schema_mismatch' }) as Result<
          PaymentCreateResponse,
          PaymentGatewayError
        >,
      ],
    ])(
      '%s: 201 PENDING without External_Id, no reconciliation and no second call',
      async (_name, answer) => {
        const s = setup();
        s.gateway.script.create.enqueue(answer);
        const output = (await run(s))._unsafeUnwrap();
        const body = bodyOf(output);
        expect(output.statusCode).toBe(201);
        expect(body.status).toBe('PENDING');
        expect(s.transactions.get(body.id)).not.toHaveProperty('externalId');
        expect(s.deliveries.get(body.deliveryId)?.status).toBe('PENDING');
        expect(s.gateway.callLog).toEqual(['create']);
      },
    );

    it('the replay of a PENDING creation after a provider failure sends no second charge', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(unavailable());
      await run(s);
      const replay = (await run(s))._unsafeUnwrap();
      expect(replay.statusCode).toBe(200);
      expect(bodyOf(replay).status).toBe('PENDING');
      expect(s.gateway.callCount('create')).toBe(1);
      expect(s.transactions.count()).toBe(1);
    });

    it('a failing finalization on the first-attempt 4xx path returns the repository error', async () => {
      const s = setup();
      jest
        .spyOn(s.transactions, 'finalize')
        .mockReturnValue(errAsync<never, RepositoryError>(REPOSITORY_FAILURE));
      s.gateway.script.create.enqueue(rejected('PROVIDER_REJECTED', false));
      const result = await run(s);
      expect(result._unsafeUnwrapErr()).toEqual(REPOSITORY_FAILURE);
    });
  });

  describe('response and stored response', () => {
    it('the 201 body has exactly the documented fields', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      const body = bodyOf((await run(s))._unsafeUnwrap());
      expect(Object.keys(body).sort()).toEqual(
        ['amounts', 'card', 'createdAt', 'deliveryId', 'id', 'reference', 'status'].sort(),
      );
      expect(Object.keys(body.amounts).sort()).toEqual(
        [
          'baseFeeInCents',
          'currency',
          'deliveryFeeInCents',
          'subtotalInCents',
          'totalInCents',
        ].sort(),
      );
      expect(body.card).toEqual({ brand: 'VISA', lastFour: '4242' });
      expect(body.createdAt).toBe('2026-05-01T10:00:00.000Z');
    });

    it.each([
      ['PENDING', providerAnswer('PENDING')],
      ['APPROVED', providerAnswer('APPROVED')],
      ['DECLINED', providerAnswer('DECLINED', { message: 'No' })],
      ['a 4xx', rejected('PROVIDER_REJECTED', false)],
      ['a provider outage', unavailable()],
    ])('the stored response equals the returned one (%s)', async (_name, answer) => {
      const s = setup();
      s.gateway.script.create.enqueue(answer);
      const output = (await run(s))._unsafeUnwrap();
      expect(s.idempotency.get(KEY)).toMatchObject({
        state: 'COMPLETED',
        statusCode: output.statusCode,
        body: output.body,
      });
    });

    it('answers the real result and warns when the idempotency record cannot be completed', async () => {
      const s = setup();
      jest
        .spyOn(s.idempotency, 'complete')
        .mockReturnValue(
          errAsync<void, RepositoryError>({ kind: 'REPOSITORY_ERROR', reason: 'Throttled' }),
        );
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      const output = (await run(s))._unsafeUnwrap();
      expect(output.statusCode).toBe(201);
      expect(bodyOf(output).status).toBe('APPROVED');
      expect(s.logger.at('warn')).toEqual([
        expect.objectContaining({
          message: 'idempotency record could not be completed',
          fields: { reason: 'Throttled' },
        }),
      ]);
      expect(JSON.stringify(s.logger.entries)).not.toContain(CARD_TOKEN);
    });

    it('a failed complete still returns the 502 answer', async () => {
      const s = setup();
      jest
        .spyOn(s.idempotency, 'complete')
        .mockReturnValue(errAsync<void, RepositoryError>(REPOSITORY_FAILURE));
      s.gateway.script.create.enqueue(rejected('PROVIDER_REJECTED', false));
      const output = (await run(s))._unsafeUnwrap();
      expect(output).toEqual({ statusCode: 502, body: PAYMENT_PROVIDER_ERROR_BODY });
    });
  });

  describe('card token', () => {
    it.each([
      ['PENDING', providerAnswer('PENDING')],
      ['APPROVED', providerAnswer('APPROVED')],
      ['DECLINED', providerAnswer('DECLINED', { message: 'No' })],
      ['an amount mismatch', providerAnswer('APPROVED', { amountInCents: 1 })],
      ['a 4xx', rejected('PROVIDER_REJECTED', false)],
      ['a provider outage', unavailable()],
    ])(
      'never reaches a repository, the idempotency record, a log or a body (%s)',
      async (_name, answer) => {
        const s = setup();
        s.gateway.script.create.enqueue(answer);
        const output = (await run(s))._unsafeUnwrap();
        const written = await everythingWritten(s, output);
        expect(written).not.toContain(CARD_TOKEN);
        expect(written).not.toContain(ACCEPTANCE_TOKEN);
        expect(written).not.toContain(PERSONAL_AUTH_TOKEN);
        expect(written).toContain(REFERENCE);
      },
    );

    it('is handed to the gateway only', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('PENDING'));
      await run(s);
      expect(s.gateway.script.create.calls[0]?.[0].cardToken).toBe(CARD_TOKEN);
    });
  });

  describe('one charge per Reference', () => {
    it('calls the gateway create once per request, never a second time for the same Reference', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(unavailable());
      await run(s);
      await run(s);
      await run(s);
      expect(s.gateway.callCount('create')).toBe(1);
      expect(s.gateway.script.create.calls.map(([request]) => request.reference)).toEqual([
        REFERENCE,
      ]);
    });

    it('never calls a gateway method other than create', async () => {
      const s = setup();
      s.gateway.script.create.enqueue(providerAnswer('APPROVED'));
      await run(s);
      expect(s.gateway.callLog).toEqual(['create']);
    });
  });
});
