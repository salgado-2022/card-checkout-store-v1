import { err, ok } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';
import type { FinalizeInput } from '../../src/application/ports/transaction-repository';
import type { Customer, Product } from '../../src/domain/entities';
import { createReference } from '../../src/domain/reference';
import { FakeApplicationLogger } from './fake-application-logger';
import { FakeClock } from './fake-clock';
import { FakeIdGenerator } from './fake-id-generator';
import { FakePaymentGateway } from './fake-payment-gateway';
import { InMemoryCustomerRepository } from './in-memory-customer-repository';
import { InMemoryDeliveryRepository } from './in-memory-delivery-repository';
import { InMemoryIdempotencyRepository, STALE_AFTER_MS } from './in-memory-idempotency-repository';
import { InMemoryProductRepository } from './in-memory-product-repository';
import { InMemoryTransactionRepository } from './in-memory-transaction-repository';

const FAILURE: RepositoryError = { kind: 'REPOSITORY_ERROR', reason: 'Injected' };
const AT = '2026-01-15T10:00:05.000Z';

const product = (overrides: Partial<Product> = {}): Product => ({
  id: 'prod-1',
  sku: 'SKU-1',
  name: 'Lamp',
  description: 'A lamp',
  imageUrl: '/images/lamp.webp',
  priceInCents: 12_000_000,
  currency: 'COP',
  stock: 5,
  ...overrides,
});

const customer = (overrides: Partial<Customer> = {}): Customer => ({
  id: 'cus-1',
  email: 'ana@example.com',
  fullName: 'Ana Perez',
  phone: '3001234567',
  documentType: 'CC',
  documentNumber: '1234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function unwrap<T, E>(result: { isOk(): boolean; _unsafeUnwrap(): T; _unsafeUnwrapErr(): E }): T {
  return result._unsafeUnwrap();
}

describe('FakeClock', () => {
  it('is settable and advanceable and hands out copies', () => {
    const clock = new FakeClock('2026-01-15T10:00:00.000Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-01-15T10:00:01.500Z');
    clock.set(new Date('2027-02-03T04:05:06.000Z'));
    const snapshot = clock.now();
    snapshot.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2027-02-03T04:05:06.000Z');
  });

  it('starts at a default instant', () => {
    expect(new FakeClock().now().toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });
});

describe('FakeIdGenerator', () => {
  it('produces unique, deterministic, ULID-shaped ids that build a valid Reference', () => {
    const generator = new FakeIdGenerator();
    const ids = Array.from({ length: 100 }, () => generator.ulid());
    expect(new Set(ids).size).toBe(100);
    ids.forEach((id) => {
      expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(createReference(id).isOk()).toBe(true);
    });
    expect(new FakeIdGenerator().ulid()).toBe(ids[0]);
  });
});

describe('InMemoryProductRepository', () => {
  it('finds all products, one by id and null for an unknown id', async () => {
    const repo = new InMemoryProductRepository([product(), product({ id: 'prod-2' })]);
    expect(unwrap(await repo.findAll())).toHaveLength(2);
    expect(unwrap(await repo.findById('prod-2'))?.id).toBe('prod-2');
    expect(unwrap(await repo.findById('missing'))).toBeNull();
  });

  it('fails every read with the injected error', async () => {
    const repo = new InMemoryProductRepository([product()]);
    repo.failure = FAILURE;
    expect((await repo.findAll())._unsafeUnwrapErr()).toEqual(FAILURE);
    expect((await repo.findById('prod-1'))._unsafeUnwrapErr()).toEqual(FAILURE);
  });
});

describe('InMemoryCustomerRepository', () => {
  const input = {
    id: 'cus-new',
    email: 'ana@example.com',
    fullName: 'Ana Perez',
    phone: '3001234567',
    documentType: 'CC' as const,
    documentNumber: '1234567',
    at: AT,
  };

  it('inserts a new customer and reports created: true', async () => {
    const repo = new InMemoryCustomerRepository();
    const { customer: stored, created } = unwrap(await repo.upsert(input));
    expect(created).toBe(true);
    expect(stored).toMatchObject({ id: 'cus-new', createdAt: AT, updatedAt: AT });
    expect(unwrap(await repo.findByEmail('ana@example.com'))).toEqual(stored);
    expect(unwrap(await repo.findById('cus-new'))).toEqual(stored);
  });

  it('keeps id and createdAt of an existing email and reports created: false', async () => {
    const repo = new InMemoryCustomerRepository([customer()]);
    const result = unwrap(await repo.upsert({ ...input, fullName: 'Ana Maria Perez' }));
    expect(result.created).toBe(false);
    expect(result.customer).toMatchObject({
      id: 'cus-1',
      fullName: 'Ana Maria Perez',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: AT,
    });
    expect(repo.count()).toBe(1);
  });

  it('returns null for unknown lookups and fails with the injected error', async () => {
    const repo = new InMemoryCustomerRepository();
    expect(unwrap(await repo.findByEmail('x@y.co'))).toBeNull();
    expect(unwrap(await repo.findById('x'))).toBeNull();
    repo.failure = FAILURE;
    expect((await repo.upsert(input))._unsafeUnwrapErr()).toEqual(FAILURE);
  });
});

describe('InMemoryDeliveryRepository', () => {
  it('creates a PENDING delivery and finds it', async () => {
    const repo = new InMemoryDeliveryRepository();
    const created = unwrap(await repo.create(newDelivery()));
    expect(created).toMatchObject({ status: 'PENDING', updatedAt: '2026-01-15T10:00:00.000Z' });
    expect(unwrap(await repo.findById('del-1'))).toEqual(created);
    expect(unwrap(await repo.findById('nope'))).toBeNull();
    expect(repo.count()).toBe(1);
  });

  it('fails with the injected error and reports a missing delivery on status update', async () => {
    const repo = new InMemoryDeliveryRepository();
    expect(repo.updateStatus('nope', 'ASSIGNED', AT)).toBe(false);
    repo.failure = FAILURE;
    expect((await repo.findById('del-1'))._unsafeUnwrapErr()).toEqual(FAILURE);
  });
});

function newDelivery() {
  return {
    id: 'del-1',
    transactionId: 'txn-1',
    productId: 'prod-1',
    quantity: 2,
    recipientName: 'Ana Perez',
    phone: '3001234567',
    addressLine1: 'Calle 1 # 2-3',
    city: 'Bogota',
    department: 'Bogota D.C.',
    createdAt: '2026-01-15T10:00:00.000Z',
  };
}

function newTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    reference: 'ORD-0000000000000000000000000A',
    productId: 'prod-1',
    quantity: 2,
    customerId: 'cus-1',
    deliveryId: 'del-1',
    unitPriceInCents: 12_000_000,
    subtotalInCents: 24_000_000,
    baseFeeInCents: 300_000,
    deliveryFeeInCents: 800_000,
    totalInCents: 25_100_000,
    currency: 'COP',
    installments: 1,
    cardBrand: 'VISA' as const,
    cardLastFour: '4242',
    createdAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryTransactionRepository', () => {
  async function setup(stock = 5) {
    const products = new InMemoryProductRepository([product({ stock })]);
    const deliveries = new InMemoryDeliveryRepository();
    const transactions = new InMemoryTransactionRepository(products, deliveries);
    await deliveries.create(newDelivery());
    await transactions.create(newTransaction());
    return { products, deliveries, transactions };
  }

  const finalizeInput = (overrides: Partial<FinalizeInput> = {}): FinalizeInput => ({
    transactionId: 'txn-1',
    deliveryId: 'del-1',
    productId: 'prod-1',
    quantity: 2,
    status: 'APPROVED',
    deliveryStatus: 'ASSIGNED',
    at: AT,
    ...overrides,
  });

  it('creates PENDING transactions findable by id and reference', async () => {
    const { transactions } = await setup();
    expect(unwrap(await transactions.findById('txn-1'))).toMatchObject({
      status: 'PENDING',
      updatedAt: '2026-01-15T10:00:00.000Z',
    });
    expect(unwrap(await transactions.findByReference('ORD-0000000000000000000000000A'))?.id).toBe(
      'txn-1',
    );
    expect(unwrap(await transactions.findById('nope'))).toBeNull();
    expect(unwrap(await transactions.findByReference('ORD-none'))).toBeNull();
    expect(transactions.count()).toBe(1);
  });

  it('stores the external id and the last sync instant', async () => {
    const { transactions } = await setup();
    await transactions.setExternalId('txn-1', 'ext-1');
    await transactions.setLastSynced('txn-1', new Date(AT));
    expect(transactions.get('txn-1')).toMatchObject({ externalId: 'ext-1', lastSyncedAt: AT });
    expect((await transactions.setExternalId('nope', 'x'))._unsafeUnwrapErr()).toEqual({
      kind: 'REPOSITORY_ERROR',
      reason: 'TransactionNotFound',
    });
  });

  it('APPROVED + ASSIGNED applies all writes and decrements the stock', async () => {
    const { products, deliveries, transactions } = await setup(5);
    const outcome = unwrap(await transactions.finalize(finalizeInput()));
    expect(outcome.kind).toBe('applied');
    expect(transactions.get('txn-1')).toMatchObject({
      status: 'APPROVED',
      finalizedAt: AT,
      updatedAt: AT,
    });
    expect(deliveries.get('del-1')?.status).toBe('ASSIGNED');
    expect(products.stockOf('prod-1')).toBe(3);
  });

  it('stores the status reason when given', async () => {
    const { transactions } = await setup();
    await transactions.finalize(
      finalizeInput({
        status: 'ERROR',
        statusReason: 'AMOUNT_MISMATCH',
        deliveryStatus: 'CANCELLED',
      }),
    );
    expect(transactions.get('txn-1')).toMatchObject({
      status: 'ERROR',
      statusReason: 'AMOUNT_MISMATCH',
    });
  });

  it.each(['CANCELLED', 'BACKORDER'] as const)(
    'delivery %s leaves the stock unchanged',
    async (deliveryStatus) => {
      const { products, deliveries, transactions } = await setup(5);
      const status = deliveryStatus === 'CANCELLED' ? 'DECLINED' : 'APPROVED';
      const outcome = unwrap(
        await transactions.finalize(finalizeInput({ status, deliveryStatus })),
      );
      expect(outcome.kind).toBe('applied');
      expect(products.stockOf('prod-1')).toBe(5);
      expect(deliveries.get('del-1')?.status).toBe(deliveryStatus);
    },
  );

  it('returns stock_unavailable without writing anything when stock < quantity', async () => {
    const { products, deliveries, transactions } = await setup(1);
    const outcome = unwrap(await transactions.finalize(finalizeInput()));
    expect(outcome).toEqual({ kind: 'stock_unavailable' });
    expect(transactions.get('txn-1')?.status).toBe('PENDING');
    expect(deliveries.get('del-1')?.status).toBe('PENDING');
    expect(products.stockOf('prod-1')).toBe(1);
    expect(transactions.appliedFinalizations).toBe(0);
  });

  it('returns stock_unavailable when the product does not exist', async () => {
    const { transactions } = await setup();
    const outcome = unwrap(await transactions.finalize(finalizeInput({ productId: 'ghost' })));
    expect(outcome.kind).toBe('stock_unavailable');
  });

  it('the second finalize is already_final and never decrements twice', async () => {
    const { products, transactions } = await setup(5);
    await transactions.finalize(finalizeInput());
    const second = unwrap(await transactions.finalize(finalizeInput()));
    expect(second.kind).toBe('already_final');
    expect(second.kind === 'already_final' && second.transaction.status).toBe('APPROVED');
    expect(products.stockOf('prod-1')).toBe(3);
    expect(transactions.appliedFinalizations).toBe(1);
  });

  it('checks the transaction status before the stock', async () => {
    const { transactions } = await setup(1);
    await transactions.finalize(finalizeInput({ status: 'DECLINED', deliveryStatus: 'CANCELLED' }));
    const outcome = unwrap(await transactions.finalize(finalizeInput()));
    expect(outcome.kind).toBe('already_final');
  });

  it('fails for an unknown transaction or delivery without writing', async () => {
    const { products, transactions } = await setup(5);
    expect(
      (await transactions.finalize(finalizeInput({ transactionId: 'nope' })))._unsafeUnwrapErr(),
    ).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'TransactionNotFound' });
    expect(
      (await transactions.finalize(finalizeInput({ deliveryId: 'nope' })))._unsafeUnwrapErr(),
    ).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'DeliveryNotFound' });
    expect(products.stockOf('prod-1')).toBe(5);
    expect(transactions.get('txn-1')?.status).toBe('PENDING');
  });

  it('fails with the injected error', async () => {
    const { transactions } = await setup();
    transactions.failure = FAILURE;
    expect((await transactions.finalize(finalizeInput()))._unsafeUnwrapErr()).toEqual(FAILURE);
  });
});

describe('InMemoryIdempotencyRepository', () => {
  const setup = () => {
    const clock = new FakeClock();
    return { clock, repo: new InMemoryIdempotencyRepository(clock) };
  };

  it('creates a record the first time', async () => {
    const { clock, repo } = setup();
    expect(unwrap(await repo.begin('k', 'h1', clock.now()))).toEqual({ kind: 'created' });
    expect(repo.get('k')).toMatchObject({ state: 'IN_PROGRESS', transactionId: null });
  });

  it('reports hash_mismatch for the same key with another hash, in progress or completed', async () => {
    const { clock, repo } = setup();
    await repo.begin('k', 'h1', clock.now());
    expect(unwrap(await repo.begin('k', 'h2', clock.now()))).toEqual({ kind: 'hash_mismatch' });
    await repo.complete('k', 201, { id: 'txn-1' });
    expect(unwrap(await repo.begin('k', 'h2', clock.now()))).toEqual({ kind: 'hash_mismatch' });
  });

  it('reports in_progress_fresh while the record is younger than 25 s', async () => {
    const { clock, repo } = setup();
    await repo.begin('k', 'h1', clock.now());
    clock.advance(STALE_AFTER_MS - 1);
    expect(unwrap(await repo.begin('k', 'h1', clock.now()))).toEqual({ kind: 'in_progress_fresh' });
  });

  it('reports in_progress_stale from 25 s on, with createdAt and a null transaction id', async () => {
    const { clock, repo } = setup();
    const createdAt = clock.now().toISOString();
    await repo.begin('k', 'h1', clock.now());
    clock.advance(STALE_AFTER_MS);
    expect(unwrap(await repo.begin('k', 'h1', clock.now()))).toEqual({
      kind: 'in_progress_stale',
      transactionId: null,
      createdAt,
    });
  });

  it('reports in_progress_stale with the attached transaction id', async () => {
    const { clock, repo } = setup();
    await repo.begin('k', 'h1', clock.now());
    await repo.attachTransactionId('k', 'txn-1');
    clock.advance(STALE_AFTER_MS + 1000);
    const outcome = unwrap(await repo.begin('k', 'h1', clock.now()));
    expect(outcome).toMatchObject({ kind: 'in_progress_stale', transactionId: 'txn-1' });
  });

  it('replays a completed record regardless of its age', async () => {
    const { clock, repo } = setup();
    await repo.begin('k', 'h1', clock.now());
    await repo.complete('k', 201, { id: 'txn-1' });
    clock.advance(10 * STALE_AFTER_MS);
    expect(unwrap(await repo.begin('k', 'h1', clock.now()))).toEqual({
      kind: 'completed',
      statusCode: 201,
      body: { id: 'txn-1' },
    });
  });

  it('release deletes the record so the key can be reused', async () => {
    const { clock, repo } = setup();
    await repo.begin('k', 'h1', clock.now());
    await repo.release('k');
    expect(unwrap(await repo.begin('k', 'other', clock.now()))).toEqual({ kind: 'created' });
  });

  it('takeOver returns taken once and lost_race for the loser of the race', async () => {
    const { clock, repo } = setup();
    await repo.begin('k', 'h1', clock.now());
    const previous = clock.now().toISOString();
    clock.advance(STALE_AFTER_MS);
    expect(unwrap(await repo.takeOver('k', previous))).toBe('taken');
    expect(repo.get('k')?.createdAt).toBe(clock.now().toISOString());
    expect(unwrap(await repo.takeOver('k', previous))).toBe('lost_race');
    expect(unwrap(await repo.begin('k', 'h1', clock.now()))).toEqual({ kind: 'in_progress_fresh' });
  });

  it('takeOver loses the race when the record vanished, completed or got a transaction id', async () => {
    const { clock, repo } = setup();
    const previous = clock.now().toISOString();
    expect(unwrap(await repo.takeOver('missing', previous))).toBe('lost_race');
    await repo.begin('done', 'h', clock.now());
    await repo.complete('done', 200, {});
    expect(unwrap(await repo.takeOver('done', previous))).toBe('lost_race');
    await repo.begin('linked', 'h', clock.now());
    await repo.attachTransactionId('linked', 'txn-1');
    expect(unwrap(await repo.takeOver('linked', previous))).toBe('lost_race');
  });

  it('fails attach and complete for an unknown key, and everything with the injected error', async () => {
    const { clock, repo } = setup();
    expect((await repo.attachTransactionId('nope', 't'))._unsafeUnwrapErr().kind).toBe(
      'REPOSITORY_ERROR',
    );
    expect((await repo.complete('nope', 200, {}))._unsafeUnwrapErr().kind).toBe('REPOSITORY_ERROR');
    repo.failure = FAILURE;
    expect((await repo.begin('k', 'h', clock.now()))._unsafeUnwrapErr()).toEqual(FAILURE);
  });
});

describe('FakePaymentGateway', () => {
  const status = {
    status: 'APPROVED' as const,
    message: null,
    amountInCents: 25_100_000,
    currency: 'COP',
    reference: 'ORD-0000000000000000000000000A',
  };

  it('records no calls until something is called, so "never called" is assertable', () => {
    const gateway = new FakePaymentGateway();
    expect(gateway.callLog).toEqual([]);
    expect(gateway.callCount('create')).toBe(0);
    expect(gateway.script.findByReference.calls).toEqual([]);
  });

  it('consumes scripted answers in order, then the fallback, and records calls by method', async () => {
    const gateway = new FakePaymentGateway();
    gateway.script.getStatus
      .enqueue(
        ok({ ...status, status: 'PENDING' }),
        err({ kind: 'UNAVAILABLE', reason: 'timeout' }),
      )
      .always(ok(status));
    expect(unwrap(await gateway.getStatus('ext-1')).status).toBe('PENDING');
    expect((await gateway.getStatus('ext-1'))._unsafeUnwrapErr().kind).toBe('UNAVAILABLE');
    expect(unwrap(await gateway.getStatus('ext-2')).status).toBe('APPROVED');
    expect(gateway.script.getStatus.calls).toEqual([['ext-1'], ['ext-1'], ['ext-2']]);
    expect(gateway.callCount('getStatus')).toBe(3);
    expect(gateway.callCount('create')).toBe(0);
    expect(gateway.callCount('findByReference')).toBe(0);
  });

  it('scripts create, findByReference and acceptance tokens and keeps a global call log', async () => {
    const gateway = new FakePaymentGateway();
    const link = { token: 'tok_test_fake', permalink: 'https://example.test/terms' };
    gateway.script.getAcceptanceTokens.enqueue(
      ok({ acceptanceToken: link, acceptPersonalAuth: link }),
    );
    gateway.script.create.enqueue(ok({ ...status, externalId: 'ext-1' }));
    gateway.script.findByReference.enqueue(
      ok({ kind: 'found', externalId: 'ext-1', status }),
      ok({ kind: 'not_found' }),
    );
    const request = {
      reference: status.reference,
      amountInCents: status.amountInCents,
      currency: 'COP',
      customerEmail: 'ana@example.com',
      acceptanceToken: 'acc_test_fake',
      acceptPersonalAuth: 'auth_test_fake',
      cardToken: 'tok_test_fake',
      installments: 1,
    };
    expect(unwrap(await gateway.getAcceptanceTokens()).acceptanceToken).toEqual(link);
    expect(unwrap(await gateway.create(request)).externalId).toBe('ext-1');
    expect(unwrap(await gateway.findByReference(status.reference)).kind).toBe('found');
    expect(unwrap(await gateway.findByReference(status.reference)).kind).toBe('not_found');
    expect(gateway.script.create.calls).toEqual([[request]]);
    expect(gateway.callLog).toEqual([
      'getAcceptanceTokens',
      'create',
      'findByReference',
      'findByReference',
    ]);
  });

  it('answers INVALID_RESPONSE when nothing is scripted', async () => {
    const gateway = new FakePaymentGateway();
    expect((await gateway.getStatus('x'))._unsafeUnwrapErr()).toEqual({
      kind: 'INVALID_RESPONSE',
      reason: 'unscripted_call',
    });
  });
});

describe('FakeApplicationLogger', () => {
  it('records entries by level with their fields', () => {
    const logger = new FakeApplicationLogger();
    logger.info('a');
    logger.warn('b', { reference: 'ORD-1' });
    logger.alert('c', { productId: 'prod-1' });
    expect(logger.entries.map((entry) => entry.level)).toEqual(['info', 'warn', 'alert']);
    expect(logger.at('warn')).toEqual([
      { level: 'warn', message: 'b', fields: { reference: 'ORD-1' } },
    ]);
    expect(logger.at('info')[0]?.fields).toEqual({});
    expect(logger.at('alert')[0]?.message).toBe('c');
  });
});
