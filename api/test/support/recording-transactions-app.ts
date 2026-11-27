import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ok, ResultAsync, type Result } from 'neverthrow';
import type { PaymentGatewayError } from '../../src/application/errors';
import type {
  PaymentCreateRequest,
  PaymentCreateResponse,
} from '../../src/application/ports/payment-gateway';
import type { NewDelivery } from '../../src/application/ports/delivery-repository';
import type {
  NewTransaction,
  FinalizeInput,
} from '../../src/application/ports/transaction-repository';
import type { Product } from '../../src/domain/entities';
import { CreateTransaction } from '../../src/application/use-cases/create-transaction';
import { FinalizeTransaction } from '../../src/application/use-cases/finalize-transaction';
import { TransactionsController } from '../../src/infrastructure/http/controllers/transactions.controller';
import { ResultExceptionFilter } from '../../src/infrastructure/http/filters/result-exception.filter';
import { GLOBAL_PREFIX } from '../../src/infrastructure/http/create-app';
import { createValidationPipe } from '../../src/infrastructure/http/validation-pipe';
import { FakeApplicationLogger, type LogEntry } from './fake-application-logger';
import { FakeClock } from './fake-clock';
import { FakeIdGenerator } from './fake-id-generator';
import { InMemoryCustomerRepository } from './in-memory-customer-repository';
import { InMemoryDeliveryRepository } from './in-memory-delivery-repository';
import { InMemoryIdempotencyRepository } from './in-memory-idempotency-repository';
import { InMemoryProductRepository } from './in-memory-product-repository';
import { InMemoryTransactionRepository } from './in-memory-transaction-repository';
import { TRANSACTION_CUSTOMER, TRANSACTION_PRODUCT } from './transactions-http-app';

/** One step of the write path, in global order. `payload` is what the step received or stored. */
export interface RecordedStep {
  readonly step: string;
  readonly payload: unknown;
}

/** Shared, ordered record of every write and gateway call made while a request is processed. */
export class StepLog {
  readonly steps: RecordedStep[] = [];

  record(step: string, payload: unknown = undefined): void {
    this.steps.push({ step, payload });
  }

  names(): string[] {
    return this.steps.map((entry) => entry.step);
  }
}

/** Log line captured from the HTTP exception filter (the filter logs its own fields). */
export interface HttpLogEntry {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Replies the recording gateway gives to `create`, computed from the request it received. */
export type GatewayReply = (
  request: PaymentCreateRequest,
) => Result<PaymentCreateResponse, PaymentGatewayError>;

/** Reply used when a test does not script one: a PENDING answer that echoes the request. */
export const pendingReply: GatewayReply = (request) =>
  ok({
    externalId: 'ext-1',
    status: 'PENDING',
    message: null,
    amountInCents: request.amountInCents,
    currency: request.currency,
    reference: request.reference,
  });

class RecordingDeliveries extends InMemoryDeliveryRepository {
  constructor(private readonly log: StepLog) {
    super();
  }

  override create(input: NewDelivery) {
    this.log.record('delivery.create', input);
    return super.create(input);
  }
}

class RecordingTransactions extends InMemoryTransactionRepository {
  constructor(
    products: InMemoryProductRepository,
    deliveries: InMemoryDeliveryRepository,
    private readonly log: StepLog,
  ) {
    super(products, deliveries);
  }

  override create(input: NewTransaction) {
    this.log.record('transaction.create', input);
    return super.create(input);
  }

  override setExternalId(id: string, externalId: string) {
    this.log.record('transaction.setExternalId', { id, externalId });
    return super.setExternalId(id, externalId);
  }

  override finalize(input: FinalizeInput) {
    this.log.record('transaction.finalize', input);
    return super.finalize(input);
  }
}

class RecordingIdempotency extends InMemoryIdempotencyRepository {
  constructor(
    clock: FakeClock,
    private readonly log: StepLog,
  ) {
    super(clock);
  }

  override begin(key: string, requestHash: string, now: Date) {
    this.log.record('idempotency.begin', { key, requestHash });
    return super.begin(key, requestHash, now);
  }

  override attachTransactionId(key: string, transactionId: string) {
    this.log.record('idempotency.attachTransactionId', { key, transactionId });
    return super.attachTransactionId(key, transactionId);
  }

  override complete(key: string, statusCode: number, body: unknown) {
    this.log.record('idempotency.complete', { key, statusCode, body });
    return super.complete(key, statusCode, body);
  }

  override release(key: string) {
    this.log.record('idempotency.release', { key });
    return super.release(key);
  }
}

/** Only `create` is reached by the use case; every call is logged before the scripted reply. */
export class RecordingGateway {
  readonly requests: PaymentCreateRequest[] = [];

  constructor(
    private readonly log: StepLog,
    private reply: GatewayReply = pendingReply,
  ) {}

  /** Replaces the reply for the following calls. */
  answerWith(reply: GatewayReply): void {
    this.reply = reply;
  }

  create(request: PaymentCreateRequest): ResultAsync<PaymentCreateResponse, PaymentGatewayError> {
    this.log.record('gateway.create', request);
    this.requests.push(request);
    return new ResultAsync(Promise.resolve(this.reply(request)));
  }
}

export interface RecordingTransactionsAppOptions {
  readonly products?: readonly Product[];
  readonly reply?: GatewayReply;
}

/**
 * Same wiring as `createTransactionsHttpApp`, but every write, gateway call, application log line
 * and HTTP log line is recorded. Built in its own file so the shared support helper stays unchanged.
 */
export interface RecordingTransactionsApp {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly products: InMemoryProductRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly transactions: InMemoryTransactionRepository;
  readonly idempotency: InMemoryIdempotencyRepository;
  readonly gateway: RecordingGateway;
  readonly steps: StepLog;
  readonly appLogs: FakeApplicationLogger;
  readonly httpLogs: HttpLogEntry[];
}

export async function createRecordingTransactionsApp(
  options: RecordingTransactionsAppOptions = {},
): Promise<RecordingTransactionsApp> {
  const steps = new StepLog();
  const clock = new FakeClock('2026-05-01T10:00:00.000Z');
  const products = new InMemoryProductRepository(options.products ?? [TRANSACTION_PRODUCT]);
  const customers = new InMemoryCustomerRepository([TRANSACTION_CUSTOMER]);
  const deliveries = new RecordingDeliveries(steps);
  const transactions = new RecordingTransactions(products, deliveries, steps);
  const idempotency = new RecordingIdempotency(clock, steps);
  const gateway = new RecordingGateway(steps, options.reply);
  const appLogs = new FakeApplicationLogger();
  const httpLogs: HttpLogEntry[] = [];
  const httpLogger = {
    warn: (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      httpLogs.push({ level: 'warn', message, fields: fields ?? {} });
    },
    error: (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      httpLogs.push({ level: 'error', message, fields: fields ?? {} });
    },
  };

  const finalize = new FinalizeTransaction(transactions, appLogs, clock);
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
    appLogs,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [TransactionsController],
    providers: [{ provide: CreateTransaction, useValue: createTransaction }],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ResultExceptionFilter(httpLogger));
  await app.init();

  return {
    app,
    clock,
    products,
    deliveries,
    transactions,
    idempotency,
    gateway,
    steps,
    appLogs,
    httpLogs,
  };
}

/** Every log line captured by the use case logger, in order. */
export function applicationLogLines(testApp: RecordingTransactionsApp): LogEntry[] {
  return [...testApp.appLogs.entries];
}
