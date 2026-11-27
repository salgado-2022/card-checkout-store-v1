import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import nock from 'nock';
import { CreateTransaction } from '../../src/application/use-cases/create-transaction';
import type {
  CreateTransactionOutput,
  CreateTransactionRequest,
} from '../../src/application/use-cases/create-transaction';
import { FinalizeTransaction } from '../../src/application/use-cases/finalize-transaction';
import {
  RECONCILIATION_WINDOW_MS,
  SyncTransactionStatus,
} from '../../src/application/use-cases/sync-transaction-status';
import type { Transaction } from '../../src/domain/entities';
import {
  resetSsmParameterCacheForTests,
  SsmParameterReader,
} from '../../src/infrastructure/config/ssm-parameter-reader';
import { PaymentGatewayAdapter } from '../../src/infrastructure/payment/payment-gateway.adapter';
import { FakeApplicationLogger } from '../support/fake-application-logger';
import { FakeClock } from '../support/fake-clock';
import { FakeIdGenerator } from '../support/fake-id-generator';
import { InMemoryCustomerRepository } from '../support/in-memory-customer-repository';
import { InMemoryDeliveryRepository } from '../support/in-memory-delivery-repository';
import { InMemoryIdempotencyRepository } from '../support/in-memory-idempotency-repository';
import { InMemoryProductRepository } from '../support/in-memory-product-repository';
import { InMemoryTransactionRepository } from '../support/in-memory-transaction-repository';
import { TRANSACTION_CUSTOMER, TRANSACTION_PRODUCT } from '../support/transactions-http-app';

const BASE_URL = 'https://payment.test';
const PRIVATE_PARAM = '/test/payment/private-key';
const INTEGRITY_PARAM = '/test/payment/integrity-secret';
const PRIVATE_VALUE = 'prv_test_fake';
const INTEGRITY_VALUE = 'integrity_test_fake';
const EXTERNAL_ID = 'ext-test-001';
const QUANTITY = 2;
// 2 x 120,000 COP + 3,000 base fee + 8,000 delivery fee, in cents.
const TOTAL_IN_CENTS = 25_100_000;
const INITIAL_STOCK = TRANSACTION_PRODUCT.stock;

// Short timings so a stalled attempt times out in milliseconds. The Reconciliation_Window is
// driven by the fake clock, not by these.
const FAST_STANDARD_TIMING = { attemptTimeoutMs: 100, backoffMs: 1 };
const FAST_SINGLE_ATTEMPT_TIMING = { attemptTimeoutMs: 200 };
const STALL_MS = 500;

const config = {
  paymentApiUrl: BASE_URL,
  paymentPublicKey: 'pub_test_fake',
  paymentPrivateKeyParam: PRIVATE_PARAM,
  paymentIntegritySecretParam: INTEGRITY_PARAM,
};

const request: CreateTransactionRequest = {
  productId: TRANSACTION_PRODUCT.id,
  quantity: QUANTITY,
  customerId: TRANSACTION_CUSTOMER.id,
  delivery: {
    recipientName: 'Ana Perez',
    phone: '3001234567',
    addressLine1: 'Calle 1 2 3',
    city: 'Medellin',
    department: 'Antioquia',
  },
  payment: { cardToken: 'tok_test_fake', installments: 1, brand: 'VISA', lastFour: '4242' },
  acceptanceToken: 'tok_test_fake_acceptance',
  acceptPersonalAuth: 'tok_test_fake_personal',
};

interface World {
  readonly clock: FakeClock;
  readonly products: InMemoryProductRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly transactions: InMemoryTransactionRepository;
  readonly logger: FakeApplicationLogger;
  readonly createTransaction: CreateTransaction;
  readonly syncTransactionStatus: SyncTransactionStatus;
}

// The real use cases over in-memory repositories and the real gateway adapter. Only the network
// (nock), SSM (aws-sdk-client-mock), the clock and the ids are substituted.
function buildWorld(): World {
  const clock = new FakeClock('2026-05-01T10:00:00.000Z');
  const products = new InMemoryProductRepository([TRANSACTION_PRODUCT]);
  const customers = new InMemoryCustomerRepository([TRANSACTION_CUSTOMER]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  const idempotency = new InMemoryIdempotencyRepository(clock);
  const logger = new FakeApplicationLogger();
  const gateway = new PaymentGatewayAdapter(
    config,
    FAST_STANDARD_TIMING,
    new SsmParameterReader(),
    FAST_SINGLE_ATTEMPT_TIMING,
  );
  const finalize = new FinalizeTransaction(transactions, logger, clock);
  const createTransaction = new CreateTransaction(
    idempotency,
    products,
    customers,
    transactions,
    deliveries,
    gateway,
    finalize,
    { baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 },
    new FakeIdGenerator(),
    clock,
    logger,
  );
  const syncTransactionStatus = new SyncTransactionStatus(
    transactions,
    gateway,
    finalize,
    logger,
    clock,
  );
  return {
    clock,
    products,
    deliveries,
    transactions,
    logger,
    createTransaction,
    syncTransactionStatus,
  };
}

interface ProviderTraffic {
  /** Matched requests, as `METHOD path`, in arrival order. */
  readonly requests: string[];
  /** Requests that reached nock with no interceptor to answer them. */
  readonly unmatched: string[];
  posts(): number;
  lookups(): number;
}

// Records every request the adapter sends. `scope.on('request')` fires for each request that
// matches an interceptor, `nock.emitter` for each one that matches none.
function observeProvider(scope: nock.Scope): ProviderTraffic {
  const requests: string[] = [];
  const unmatched: string[] = [];
  scope.on('request', (req: { method: string; path: string }) => {
    requests.push(`${req.method} ${req.path}`);
  });
  nock.emitter.on('no match', (req: { method?: string; path?: string }) => {
    unmatched.push(`${req.method ?? '?'} ${req.path ?? '?'}`);
  });
  return {
    requests,
    unmatched,
    posts: () => requests.filter((line) => line.startsWith('POST ')).length,
    lookups: () =>
      requests.filter((line) => line.startsWith('GET /transactions?reference=')).length,
  };
}

const itemFor = (reference: string, status: string): Record<string, unknown> => ({
  id: EXTERNAL_ID,
  status,
  status_message: status === 'APPROVED' ? null : 'Pending',
  reference,
  amount_in_cents: TOTAL_IN_CENTS,
  currency: 'COP',
  unrelated_field: 'ignored',
});

// First POST attempt: the provider accepts the connection but answers after the attempt timeout.
const stallFirstPost = (scope: nock.Scope): void => {
  scope.post('/transactions').delayConnection(STALL_MS).reply(201, { data: {} });
};

const lookupInterceptor = (scope: nock.Scope, reference: string): nock.Interceptor =>
  scope.get('/transactions').query((query) => query['reference'] === reference);

const referenceOf = (transaction: Transaction): string => transaction.reference;

async function createAndLoad(
  world: World,
): Promise<{ readonly output: CreateTransactionOutput; readonly transaction: Transaction }> {
  const result = await world.createTransaction.execute({
    idempotencyKey: 'idem-key-0001',
    request,
  });
  const output = result._unsafeUnwrap();
  const id = (output.body as { id: string }).id;
  const transaction = world.transactions.get(id);
  if (transaction === undefined) {
    throw new Error('transaction was not stored');
  }
  return { output, transaction };
}

describe('provider unreachable during creation', () => {
  const ssm = mockClient(SSMClient);

  beforeAll(() => {
    nock.disableNetConnect();
  });

  beforeEach(() => {
    nock.cleanAll();
    nock.emitter.removeAllListeners('no match');
    resetSsmParameterCacheForTests();
    ssm.reset();
    ssm.on(GetParameterCommand, { Name: PRIVATE_PARAM }).resolves({
      Parameter: { Value: PRIVATE_VALUE },
    });
    ssm.on(GetParameterCommand, { Name: INTEGRITY_PARAM }).resolves({
      Parameter: { Value: INTEGRITY_VALUE },
    });
  });

  afterEach(() => {
    nock.emitter.removeAllListeners('no match');
  });

  afterAll(() => {
    ssm.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('timeout on the first attempt and a 5xx on the retry', () => {
    it('answers 201 PENDING without External_Id and links it later with one lookup and no second creation', async () => {
      const world = buildWorld();
      const scope = nock(BASE_URL);
      const traffic = observeProvider(scope);
      stallFirstPost(scope);
      scope.post('/transactions').reply(503, { error: { type: 'SERVICE_UNAVAILABLE' } });

      const { output, transaction } = await createAndLoad(world);

      expect(output.statusCode).toBe(201);
      expect(output.body).toMatchObject({ status: 'PENDING', reference: transaction.reference });
      expect(transaction.status).toBe('PENDING');
      expect(transaction.externalId).toBeUndefined();
      expect(traffic.requests).toEqual(['POST /transactions', 'POST /transactions']);
      expect(traffic.lookups()).toBe(0);
      expect(world.logger.at('warn').map((entry) => entry.message)).toContain(
        'payment creation left pending without external id',
      );

      lookupInterceptor(scope, referenceOf(transaction)).reply(200, {
        data: [itemFor(referenceOf(transaction), 'PENDING')],
        meta: {},
      });
      const synced = (await world.syncTransactionStatus.execute(transaction.id))._unsafeUnwrap();

      expect(synced.status).toBe('PENDING');
      expect(synced.externalId).toBe(EXTERNAL_ID);
      expect(world.transactions.get(transaction.id)?.externalId).toBe(EXTERNAL_ID);
      expect(traffic.lookups()).toBe(1);
      expect(traffic.posts()).toBe(2);
      expect(traffic.requests).toHaveLength(3);
      expect(traffic.unmatched).toEqual([]);
      expect(nock.pendingMocks()).toEqual([]);
      expect(world.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(INITIAL_STOCK);
    });

    it('keeps PENDING before 60 s and ends ERROR PROVIDER_UNREACHABLE at 60 s when the lookup finds nothing', async () => {
      const world = buildWorld();
      const scope = nock(BASE_URL);
      const traffic = observeProvider(scope);
      stallFirstPost(scope);
      scope.post('/transactions').reply(503, { error: { type: 'SERVICE_UNAVAILABLE' } });

      const { transaction } = await createAndLoad(world);
      const reference = referenceOf(transaction);
      lookupInterceptor(scope, reference).times(2).reply(200, { data: [], meta: {} });

      world.clock.advance(RECONCILIATION_WINDOW_MS - 1);
      const early = (await world.syncTransactionStatus.execute(transaction.id))._unsafeUnwrap();

      expect(early.status).toBe('PENDING');
      expect(early.externalId).toBeUndefined();
      expect(world.deliveries.get(transaction.deliveryId)?.status).toBe('PENDING');
      expect(world.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(INITIAL_STOCK);
      expect(world.transactions.appliedFinalizations).toBe(0);
      expect(traffic.lookups()).toBe(1);

      world.clock.advance(1);
      const late = (await world.syncTransactionStatus.execute(transaction.id))._unsafeUnwrap();

      expect(late.status).toBe('ERROR');
      expect(late.statusReason).toBe('PROVIDER_UNREACHABLE');
      expect(late.externalId).toBeUndefined();
      expect(world.deliveries.get(transaction.deliveryId)?.status).toBe('CANCELLED');
      expect(world.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(INITIAL_STOCK);
      expect(world.transactions.appliedFinalizations).toBe(1);
      expect(traffic.lookups()).toBe(2);
      expect(traffic.posts()).toBe(2);
      expect(traffic.unmatched).toEqual([]);
      expect(nock.pendingMocks()).toEqual([]);

      const afterFinal = (
        await world.syncTransactionStatus.execute(transaction.id)
      )._unsafeUnwrap();
      expect(afterFinal.status).toBe('ERROR');
      expect(traffic.lookups()).toBe(2);
    });
  });

  describe('timeout on the first attempt and a 4xx on the retry', () => {
    it('answers 201 PENDING with no lookup during the POST, then the GET reconciles an approved payment', async () => {
      const world = buildWorld();
      const scope = nock(BASE_URL);
      const traffic = observeProvider(scope);
      stallFirstPost(scope);
      scope.post('/transactions').reply(422, { error: { type: 'INPUT_VALIDATION_ERROR' } });

      const { output, transaction } = await createAndLoad(world);

      expect(output.statusCode).toBe(201);
      expect(output.body).toMatchObject({ status: 'PENDING' });
      expect(transaction.status).toBe('PENDING');
      expect(transaction.externalId).toBeUndefined();
      expect(traffic.requests).toEqual(['POST /transactions', 'POST /transactions']);
      expect(traffic.lookups()).toBe(0);
      expect(world.deliveries.get(transaction.deliveryId)?.status).toBe('PENDING');
      expect(world.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(INITIAL_STOCK);

      lookupInterceptor(scope, referenceOf(transaction)).reply(200, {
        data: [itemFor(referenceOf(transaction), 'APPROVED')],
        meta: {},
      });
      const synced = (await world.syncTransactionStatus.execute(transaction.id))._unsafeUnwrap();

      expect(synced.status).toBe('APPROVED');
      expect(synced.externalId).toBe(EXTERNAL_ID);
      expect(world.deliveries.get(transaction.deliveryId)?.status).toBe('ASSIGNED');
      expect(world.products.stockOf(TRANSACTION_PRODUCT.id)).toBe(INITIAL_STOCK - QUANTITY);
      expect(traffic.lookups()).toBe(1);
      expect(traffic.posts()).toBe(2);
      expect(traffic.unmatched).toEqual([]);
      expect(nock.pendingMocks()).toEqual([]);
    });
  });
});
