import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import nock from 'nock';
import { err, errAsync } from 'neverthrow';
import type { RepositoryError } from '../application/errors';
import { FinalizeTransaction } from '../application/use-cases/finalize-transaction';
import { GetAcceptanceTokens } from '../application/use-cases/get-acceptance-tokens';
import { GetCustomer } from '../application/use-cases/get-customer';
import { GetDelivery } from '../application/use-cases/get-delivery';
import { GetFees } from '../application/use-cases/get-fees';
import { GetProduct } from '../application/use-cases/get-product';
import { GetProducts } from '../application/use-cases/get-products';
import { SyncTransactionStatus } from '../application/use-cases/sync-transaction-status';
import { UpsertCustomer } from '../application/use-cases/upsert-customer';
import { CreateTransaction } from '../application/use-cases/create-transaction';
import type { CustomerRepository } from '../application/ports/customer-repository';
import type { DeliveryRepository } from '../application/ports/delivery-repository';
import type { IdempotencyRepository } from '../application/ports/idempotency-repository';
import type { ProductRepository } from '../application/ports/product-repository';
import type { TransactionRepository } from '../application/ports/transaction-repository';
import type { Transaction } from '../domain/entities';
import { DynamoCustomerRepository } from './persistence/customer.repository.dynamodb';
import { DynamoDeliveryRepository } from './persistence/delivery.repository.dynamodb';
import { DynamoIdempotencyRepository } from './persistence/idempotency.repository.dynamodb';
import { DynamoProductRepository } from './persistence/product.repository.dynamodb';
import { DynamoTransactionRepository } from './persistence/transaction.repository.dynamodb';
import { PaymentGatewayAdapter } from './payment/payment-gateway.adapter';
import { resetSsmParameterCacheForTests, SsmParameterReader } from './config/ssm-parameter-reader';
import { FakeApplicationLogger } from '../../test/support/fake-application-logger';
import { FakeClock } from '../../test/support/fake-clock';
import { FakeIdGenerator } from '../../test/support/fake-id-generator';
import { FakePaymentGateway } from '../../test/support/fake-payment-gateway';
import { InMemoryCustomerRepository } from '../../test/support/in-memory-customer-repository';
import { InMemoryDeliveryRepository } from '../../test/support/in-memory-delivery-repository';
import { InMemoryIdempotencyRepository } from '../../test/support/in-memory-idempotency-repository';
import { InMemoryProductRepository } from '../../test/support/in-memory-product-repository';
import { InMemoryTransactionRepository } from '../../test/support/in-memory-transaction-repository';
import {
  TRANSACTION_CUSTOMER,
  TRANSACTION_PRODUCT,
} from '../../test/support/transactions-http-app';

// Feature: payments-api, Property 42: Use cases and adapters never throw for business failures

const NUM_RUNS = 100;
const PROPERTY_TIMEOUT_MS = 60_000;
const BASE_URL = 'https://payment.test';
const PRIVATE_PARAM = '/test/payment/private-key';
const INTEGRITY_PARAM = '/test/payment/integrity-secret';
const PRIVATE_VALUE = 'prv_test_fake';
const INTEGRITY_VALUE = 'integrity_test_fake';
const PUBLIC_KEY = 'pub_test_fake';
const FEES = { baseFeeInCents: 300_000, deliveryFeeInCents: 800_000 };

/** A storage failure: the only way a port can fail. The reason is a class name, never a message. */
const STORAGE_FAILURE: RepositoryError = { kind: 'REPOSITORY_ERROR', reason: 'ServiceUnavailable' };

/**
 * A port whose every method fails with a storage error. A Proxy answers any method name, so the
 * table does not have to list each method of each port.
 */
function failingPort<T>(): T {
  return new Proxy({}, { get: () => () => errAsync<never, RepositoryError>(STORAGE_FAILURE) }) as T;
}

const ulidArbitrary = fc.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const idArbitrary = fc.string({ minLength: 1, maxLength: 40 });
const emailArbitrary = fc.emailAddress();

type Expectation = 'err' | 'ok';

/** Any Result or ResultAsync: both answer `isErr` once awaited. */
interface ResultLike {
  isErr(): boolean;
}

interface Case {
  readonly name: string;
  readonly expect: Expectation;
  /** Returns a Result, or a ResultAsync that `await` unwraps to one. */
  readonly run: () => unknown;
}

/** Use cases with each documented business error, plus a storage failure for each port. */
function useCaseCases(input: { id: string; email: string; ulid: string }): Case[] {
  const clock = new FakeClock();
  const logger = new FakeApplicationLogger();
  const ids = new FakeIdGenerator();
  const emptyProducts = new InMemoryProductRepository([]);
  const emptyCustomers = new InMemoryCustomerRepository([]);
  const emptyDeliveries = new InMemoryDeliveryRepository();
  const emptyTransactions = new InMemoryTransactionRepository(emptyProducts, emptyDeliveries);
  const storedTransaction: Transaction = {
    id: input.ulid,
    reference: `ORD-${input.ulid}`,
    status: 'PENDING',
    productId: TRANSACTION_PRODUCT.id,
    quantity: 1,
    customerId: TRANSACTION_CUSTOMER.id,
    deliveryId: input.ulid,
    unitPriceInCents: TRANSACTION_PRODUCT.priceInCents,
    subtotalInCents: TRANSACTION_PRODUCT.priceInCents,
    baseFeeInCents: FEES.baseFeeInCents,
    deliveryFeeInCents: FEES.deliveryFeeInCents,
    totalInCents: TRANSACTION_PRODUCT.priceInCents + FEES.baseFeeInCents + FEES.deliveryFeeInCents,
    currency: 'COP',
    installments: 1,
    cardBrand: 'VISA',
    cardLastFour: '4242',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
  };
  const createRequest = {
    productId: TRANSACTION_PRODUCT.id,
    quantity: 1,
    customerId: TRANSACTION_CUSTOMER.id,
    delivery: {
      recipientName: 'Ana Perez',
      phone: '3001234567',
      addressLine1: 'Calle 1 # 2-3',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
    },
    payment: {
      cardToken: 'tok_test_fake',
      installments: 1,
      brand: 'VISA' as const,
      lastFour: '4242',
    },
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
  };
  const createWith = (overrides: {
    idempotency?: IdempotencyRepository;
    products?: ProductRepository;
    customers?: CustomerRepository;
    transactions?: TransactionRepository;
    deliveries?: DeliveryRepository;
  }) => {
    const finalize = new FinalizeTransaction(emptyTransactions, logger, clock);
    return new CreateTransaction(
      overrides.idempotency ?? new InMemoryIdempotencyRepository(clock),
      overrides.products ?? new InMemoryProductRepository([TRANSACTION_PRODUCT]),
      overrides.customers ?? new InMemoryCustomerRepository([TRANSACTION_CUSTOMER]),
      overrides.transactions ?? emptyTransactions,
      overrides.deliveries ?? emptyDeliveries,
      new FakePaymentGateway(),
      finalize,
      FEES,
      ids,
      clock,
      logger,
    );
  };

  return [
    // GetProducts, GetProduct
    {
      name: 'GetProducts storage failure',
      expect: 'err',
      run: () => new GetProducts(failingPort<ProductRepository>()).execute(),
    },
    {
      name: 'GetProduct unknown id',
      expect: 'err',
      run: () => new GetProduct(emptyProducts).execute(input.id),
    },
    {
      name: 'GetProduct storage failure',
      expect: 'err',
      run: () => new GetProduct(failingPort<ProductRepository>()).execute(input.id),
    },
    // GetFees has no failure path: it must return Ok and never throw.
    { name: 'GetFees', expect: 'ok', run: () => new GetFees(FEES).execute() },
    // UpsertCustomer, GetCustomer
    {
      name: 'UpsertCustomer storage failure',
      expect: 'err',
      run: () =>
        new UpsertCustomer(failingPort<CustomerRepository>(), ids, clock, logger).execute({
          email: input.email,
          fullName: 'Ana Perez',
          phone: '3001234567',
          documentType: 'CC',
          documentNumber: '1234567890',
        }),
    },
    {
      name: 'GetCustomer unknown id',
      expect: 'err',
      run: () => new GetCustomer(emptyCustomers).execute(input.id),
    },
    {
      name: 'GetCustomer storage failure',
      expect: 'err',
      run: () => new GetCustomer(failingPort<CustomerRepository>()).execute(input.id),
    },
    // GetAcceptanceTokens: a provider failure becomes PAYMENT_PROVIDER_ERROR.
    {
      name: 'GetAcceptanceTokens provider failure',
      expect: 'err',
      run: () =>
        new GetAcceptanceTokens(
          { getAcceptanceTokens: () => errAsync({ kind: 'UNAVAILABLE', reason: '500' }) },
          logger,
        ).execute(),
    },
    // GetDelivery
    {
      name: 'GetDelivery unknown id',
      expect: 'err',
      run: () => new GetDelivery(emptyDeliveries).execute(input.id),
    },
    {
      name: 'GetDelivery storage failure',
      expect: 'err',
      run: () => new GetDelivery(failingPort<DeliveryRepository>()).execute(input.id),
    },
    // CreateTransaction: key validation, referential checks, stock and storage.
    {
      name: 'CreateTransaction missing Idempotency-Key',
      expect: 'err',
      run: () => createWith({}).execute({ idempotencyKey: undefined, request: createRequest }),
    },
    {
      name: 'CreateTransaction malformed Idempotency-Key',
      expect: 'err',
      run: () => createWith({}).execute({ idempotencyKey: 'x', request: createRequest }),
    },
    {
      name: 'CreateTransaction unknown product',
      expect: 'err',
      run: () =>
        createWith({ products: emptyProducts }).execute({
          idempotencyKey: 'key-0000001',
          request: createRequest,
        }),
    },
    {
      name: 'CreateTransaction unknown customer',
      expect: 'err',
      run: () =>
        createWith({ customers: emptyCustomers }).execute({
          idempotencyKey: 'key-0000002',
          request: createRequest,
        }),
    },
    {
      name: 'CreateTransaction insufficient stock',
      expect: 'err',
      run: () =>
        createWith({
          products: new InMemoryProductRepository([{ ...TRANSACTION_PRODUCT, stock: 0 }]),
        }).execute({ idempotencyKey: 'key-0000003', request: createRequest }),
    },
    {
      name: 'CreateTransaction idempotency storage failure',
      expect: 'err',
      run: () =>
        createWith({ idempotency: failingPort<IdempotencyRepository>() }).execute({
          idempotencyKey: 'key-0000004',
          request: createRequest,
        }),
    },
    {
      name: 'CreateTransaction product storage failure',
      expect: 'err',
      run: () =>
        createWith({ products: failingPort<ProductRepository>() }).execute({
          idempotencyKey: 'key-0000005',
          request: createRequest,
        }),
    },
    {
      name: 'CreateTransaction transaction storage failure',
      expect: 'err',
      run: () =>
        createWith({ transactions: failingPort<TransactionRepository>() }).execute({
          idempotencyKey: 'key-0000006',
          request: createRequest,
        }),
    },
    {
      name: 'CreateTransaction delivery storage failure',
      expect: 'err',
      run: () =>
        createWith({ deliveries: failingPort<DeliveryRepository>() }).execute({
          idempotencyKey: 'key-0000007',
          request: createRequest,
        }),
    },
    // SyncTransactionStatus: unknown id and storage failure. A provider failure is absorbed (Ok).
    {
      name: 'SyncTransactionStatus unknown id',
      expect: 'err',
      run: () =>
        new SyncTransactionStatus(
          emptyTransactions,
          new FakePaymentGateway(),
          new FinalizeTransaction(emptyTransactions, logger, clock),
          logger,
          clock,
        ).execute(input.ulid),
    },
    {
      name: 'SyncTransactionStatus storage failure',
      expect: 'err',
      run: () =>
        new SyncTransactionStatus(
          failingPort<TransactionRepository>(),
          new FakePaymentGateway(),
          new FinalizeTransaction(emptyTransactions, logger, clock),
          logger,
          clock,
        ).execute(input.ulid),
    },
    // FinalizeTransaction: storage failure on the one write it makes.
    {
      name: 'FinalizeTransaction storage failure',
      expect: 'err',
      run: () =>
        new FinalizeTransaction(failingPort<TransactionRepository>(), logger, clock).execute(
          storedTransaction,
          { source: 'internal', status: 'ERROR', statusReason: 'PROVIDER_UNREACHABLE' },
        ),
    },
  ];
}

/** Table rows for the DynamoDB adapters: every method, with the client failing on any command. */
function dynamoCases(
  client: DynamoDBDocumentClient,
  input: { id: string; email: string; ulid: string },
): Case[] {
  const clock = new FakeClock();
  const products = new DynamoProductRepository(client, 'products');
  const customers = new DynamoCustomerRepository(client, 'customers');
  const deliveries = new DynamoDeliveryRepository(client, 'deliveries');
  const transactions = new DynamoTransactionRepository(client, 'transactions', {
    deliveries: 'deliveries',
    products: 'products',
  });
  const idempotency = new DynamoIdempotencyRepository(client, 'idempotency', clock);
  const now = clock.now();
  return [
    { name: 'DynamoProductRepository.findAll', expect: 'err', run: () => products.findAll() },
    {
      name: 'DynamoProductRepository.findById',
      expect: 'err',
      run: () => products.findById(input.id),
    },
    {
      name: 'DynamoCustomerRepository.findByEmail',
      expect: 'err',
      run: () => customers.findByEmail(input.email),
    },
    {
      name: 'DynamoCustomerRepository.findById',
      expect: 'err',
      run: () => customers.findById(input.id),
    },
    {
      name: 'DynamoCustomerRepository.upsert',
      expect: 'err',
      run: () =>
        customers.upsert({
          id: input.ulid,
          email: input.email,
          fullName: 'Ana Perez',
          phone: '3001234567',
          documentType: 'CC',
          documentNumber: '1234567890',
          at: now.toISOString(),
        }),
    },
    {
      name: 'DynamoDeliveryRepository.findById',
      expect: 'err',
      run: () => deliveries.findById(input.id),
    },
    {
      name: 'DynamoDeliveryRepository.create',
      expect: 'err',
      run: () =>
        deliveries.create({
          id: input.ulid,
          transactionId: input.ulid,
          productId: 'prod-1',
          quantity: 1,
          recipientName: 'Ana Perez',
          phone: '3001234567',
          addressLine1: 'Calle 1 # 2-3',
          city: 'Bogotá',
          department: 'Bogotá D.C.',
          createdAt: now.toISOString(),
        }),
    },
    {
      name: 'DynamoTransactionRepository.findById',
      expect: 'err',
      run: () => transactions.findById(input.ulid),
    },
    {
      name: 'DynamoTransactionRepository.findByReference',
      expect: 'err',
      run: () => transactions.findByReference(`ORD-${input.ulid}`),
    },
    {
      name: 'DynamoTransactionRepository.setExternalId',
      expect: 'err',
      run: () => transactions.setExternalId(input.ulid, input.id),
    },
    {
      name: 'DynamoTransactionRepository.setLastSynced',
      expect: 'err',
      run: () => transactions.setLastSynced(input.ulid, now),
    },
    {
      name: 'DynamoTransactionRepository.finalize',
      expect: 'err',
      run: () =>
        transactions.finalize({
          transactionId: input.ulid,
          deliveryId: input.ulid,
          productId: 'prod-1',
          quantity: 1,
          status: 'APPROVED',
          deliveryStatus: 'ASSIGNED',
          at: now.toISOString(),
        }),
    },
    {
      name: 'DynamoIdempotencyRepository.begin',
      expect: 'err',
      run: () => idempotency.begin(input.id, 'hash', now),
    },
    {
      name: 'DynamoIdempotencyRepository.attachTransactionId',
      expect: 'err',
      run: () => idempotency.attachTransactionId(input.id, input.ulid),
    },
    {
      name: 'DynamoIdempotencyRepository.complete',
      expect: 'err',
      run: () => idempotency.complete(input.id, 201, { id: input.ulid }),
    },
    {
      name: 'DynamoIdempotencyRepository.release',
      expect: 'err',
      run: () => idempotency.release(input.id),
    },
    {
      name: 'DynamoIdempotencyRepository.takeOver',
      expect: 'err',
      run: () => idempotency.takeOver(input.id, now.toISOString()),
    },
  ];
}

/** Table rows for the payment gateway adapter, with the provider answering each documented failure. */
interface GatewayRow extends Case {
  readonly reply: () => void;
  /** True when the private key cannot be read from SSM for this case. */
  readonly secretUnavailable?: boolean;
}

function gatewayCases(input: { id: string; ulid: string }): GatewayRow[] {
  const adapter = new PaymentGatewayAdapter(
    {
      paymentApiUrl: BASE_URL,
      paymentPublicKey: PUBLIC_KEY,
      paymentPrivateKeyParam: PRIVATE_PARAM,
      paymentIntegritySecretParam: INTEGRITY_PARAM,
    },
    { attemptTimeoutMs: 100, backoffMs: 1 },
    new SsmParameterReader(),
    { attemptTimeoutMs: 100 },
  );
  const createRequest = {
    reference: `ORD-${input.ulid}`,
    amountInCents: 25_100_000,
    currency: 'COP',
    customerEmail: 'ana@example.com',
    acceptanceToken: 'acc_test_fake',
    acceptPersonalAuth: 'auth_test_fake',
    cardToken: 'tok_test_fake',
    installments: 1,
  };
  return [
    {
      name: 'gateway getAcceptanceTokens 5xx twice',
      expect: 'err',
      reply: () => nock(BASE_URL).get(`/merchants/${PUBLIC_KEY}`).times(2).reply(500, {}),
      run: () => adapter.getAcceptanceTokens(),
    },
    {
      name: 'gateway getAcceptanceTokens invalid JSON',
      expect: 'err',
      reply: () =>
        nock(BASE_URL)
          .get(`/merchants/${PUBLIC_KEY}`)
          .reply(200, 'not json', { 'Content-Type': 'application/json' }),
      run: () => adapter.getAcceptanceTokens(),
    },
    {
      name: 'gateway create secret unavailable',
      expect: 'err',
      secretUnavailable: true,
      reply: () => undefined,
      run: () => adapter.create(createRequest),
    },
    {
      name: 'gateway getStatus 401',
      expect: 'err',
      reply: () =>
        nock(BASE_URL)
          .get(`/transactions/${input.id}`)
          .reply(401, { error: { type: 'INVALID_ACCESS_TOKEN' } }),
      run: () => adapter.getStatus(input.id),
    },
    {
      name: 'gateway getStatus 5xx',
      expect: 'err',
      reply: () => nock(BASE_URL).get(`/transactions/${input.id}`).reply(503, {}),
      run: () => adapter.getStatus(input.id),
    },
    {
      name: 'gateway getStatus invalid body',
      expect: 'err',
      reply: () => nock(BASE_URL).get(`/transactions/${input.id}`).reply(200, { data: 'nope' }),
      run: () => adapter.getStatus(input.id),
    },
    {
      name: 'gateway findByReference 401',
      expect: 'err',
      reply: () =>
        nock(BASE_URL)
          .get('/transactions')
          .query({ reference: `ORD-${input.ulid}` })
          .reply(401, { error: { type: 'INVALID_ACCESS_TOKEN' } }),
      run: () => adapter.findByReference(`ORD-${input.ulid}`),
    },
    {
      name: 'gateway findByReference 5xx',
      expect: 'err',
      reply: () =>
        nock(BASE_URL)
          .get('/transactions')
          .query({ reference: `ORD-${input.ulid}` })
          .reply(500, {}),
      run: () => adapter.findByReference(`ORD-${input.ulid}`),
    },
  ];
}

/**
 * A fresh CreateTransaction whose provider rejects the first creation attempt with a 4xx. Every
 * run builds its own repositories, so a stored Idempotency-Key never leaks between runs.
 */
function createWithRejectedProvider(): { useCase: CreateTransaction; gateway: FakePaymentGateway } {
  const clock = new FakeClock();
  const logger = new FakeApplicationLogger();
  const products = new InMemoryProductRepository([TRANSACTION_PRODUCT]);
  const customers = new InMemoryCustomerRepository([TRANSACTION_CUSTOMER]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  const gateway = new FakePaymentGateway();
  gateway.script.create.always(
    err({ kind: 'REJECTED', providerMessage: 'card_rejected', afterTransientFailure: false }),
  );
  const useCase = new CreateTransaction(
    new InMemoryIdempotencyRepository(clock),
    products,
    customers,
    transactions,
    deliveries,
    gateway,
    new FinalizeTransaction(transactions, logger, clock),
    FEES,
    new FakeIdGenerator(),
    clock,
    logger,
  );
  return { useCase, gateway };
}

const REJECTED_CREATE_REQUEST = {
  productId: TRANSACTION_PRODUCT.id,
  quantity: 1,
  customerId: TRANSACTION_CUSTOMER.id,
  delivery: {
    recipientName: 'Ana Perez',
    phone: '3001234567',
    addressLine1: 'Calle 1 # 2-3',
    city: 'Bogotá',
    department: 'Bogotá D.C.',
  },
  payment: {
    cardToken: 'tok_test_fake',
    installments: 1,
    brand: 'VISA' as const,
    lastFour: '4242',
  },
  acceptanceToken: 'acc_test_fake',
  acceptPersonalAuth: 'auth_test_fake',
};

async function expectErrOrOk(
  name: string,
  expectation: Expectation,
  run: Case['run'],
): Promise<void> {
  let result: ResultLike;
  try {
    result = (await run()) as ResultLike;
  } catch (error) {
    throw new Error(`${name} threw instead of resolving to a Result`, { cause: error });
  }
  expect({ name, isErr: result.isErr() }).toEqual({ name, isErr: expectation === 'err' });
}

describe('Feature: payments-api, Property 42: Use cases and adapters never throw for business failures', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const ssm = mockClient(SSMClient);
  const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));

  beforeAll(() => {
    nock.disableNetConnect();
  });

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.rejects(new Error('ServiceUnavailable'));
    nock.cleanAll();
    ssm.reset();
    resetSsmParameterCacheForTests();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    ddbMock.restore();
    ssm.restore();
    nock.enableNetConnect();
  });

  const inputArbitrary = fc.record({ id: idArbitrary, email: emailArbitrary, ulid: ulidArbitrary });

  it(
    'resolves every documented business failure of the non-webhook use cases to Err, without throwing',
    async () => {
      await fc.assert(
        fc.asyncProperty(inputArbitrary, async (input) => {
          for (const testCase of useCaseCases(input)) {
            await expectErrOrOk(testCase.name, testCase.expect, testCase.run);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'resolves every repository adapter failure to Err, without rejecting',
    async () => {
      await fc.assert(
        fc.asyncProperty(inputArbitrary, async (input) => {
          for (const testCase of dynamoCases(dynamoClient, input)) {
            await expectErrOrOk(testCase.name, testCase.expect, testCase.run);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'resolves every payment gateway adapter failure to Err, without rejecting',
    async () => {
      await fc.assert(
        fc.asyncProperty(inputArbitrary, async (input) => {
          for (const testCase of gatewayCases(input)) {
            nock.cleanAll();
            resetSsmParameterCacheForTests();
            ssm.reset();
            if (testCase.secretUnavailable) {
              ssm
                .on(GetParameterCommand, { Name: PRIVATE_PARAM })
                .rejects(new Error('AccessDenied'));
            } else {
              ssm.on(GetParameterCommand, { Name: PRIVATE_PARAM }).resolves({
                Parameter: { Value: PRIVATE_VALUE },
              });
            }
            ssm.on(GetParameterCommand, { Name: INTEGRITY_PARAM }).resolves({
              Parameter: { Value: INTEGRITY_VALUE },
            });
            testCase.reply();
            await expectErrOrOk(testCase.name, testCase.expect, testCase.run);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  // Requirements 6.6 and 7.6: a provider 4xx on the first attempt is a recorded Ok 502, not an Err.
  it(
    'answers a provider 4xx on the first creation attempt with Ok 502 and replays it unchanged',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9]{8,64}$/), async (idempotencyKey) => {
          const { useCase, gateway } = createWithRejectedProvider();
          const command = { idempotencyKey, request: REJECTED_CREATE_REQUEST };

          // Awaiting must not reject: a thrown exception fails the property.
          const first = await useCase.execute(command);
          expect(first.isOk()).toBe(true);
          const firstOutput = first.isOk() ? first.value : undefined;
          expect(firstOutput?.statusCode).toBe(502);
          expect(firstOutput?.body).toMatchObject({
            statusCode: 502,
            code: 'PAYMENT_PROVIDER_ERROR',
          });

          // The same key replays the stored response without a second provider call.
          const replay = await useCase.execute(command);
          expect(replay.isOk()).toBe(true);
          const replayOutput = replay.isOk() ? replay.value : undefined;
          expect(replayOutput?.statusCode).toBe(firstOutput?.statusCode);
          expect(replayOutput?.body).toEqual(firstOutput?.body);
          expect(gateway.callCount('create')).toBe(1);
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
