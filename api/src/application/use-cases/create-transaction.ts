import { err, errAsync, ok, okAsync, type Result, type ResultAsync } from 'neverthrow';
import { computeAmounts, type Amounts } from '../../domain/amounts';
import type { CardBrand } from '../../domain/card-brand';
import type { Customer, Delivery, Product, Transaction } from '../../domain/entities';
import type { DomainError } from '../../domain/errors';
import { createReference, type Reference } from '../../domain/reference';
import { isFinalStatus, type FinalStatus } from '../../domain/transaction-status';
import type { ApplicationError, PaymentGatewayError, RepositoryError } from '../errors';
import type { ApplicationLogger } from '../ports/application-logger';
import type { Clock } from '../ports/clock';
import type { CustomerRepository } from '../ports/customer-repository';
import type { DeliveryRepository, NewDelivery } from '../ports/delivery-repository';
import type { IdGenerator } from '../ports/id-generator';
import type { BeginOutcome, IdempotencyRepository } from '../ports/idempotency-repository';
import type {
  PaymentCreateRequest,
  PaymentCreateResponse,
  PaymentGateway,
} from '../ports/payment-gateway';
import type { ProductRepository } from '../ports/product-repository';
import type { NewTransaction, TransactionRepository } from '../ports/transaction-repository';
import { requestHash, type JsonValue } from '../request-hash';
import { toTransactionResponse } from './transaction-response';

export type { TransactionResponseBody } from './transaction-response';
import type { FeeSchedule } from './get-fees';
import { providerReason } from '../provider-reason';
import type { FinalizeTransaction } from './finalize-transaction';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const IDEMPOTENCY_KEY_FIELD = 'Idempotency-Key';
const IDEMPOTENCY_KEY_RULE = 'must be 8 to 128 characters from letters, digits, ".", "_" and "-"';

export type CreateTransactionError = ApplicationError | DomainError;

/** Request body of `POST /transactions`, already validated by the DTO layer. */
export interface CreateTransactionRequest {
  readonly productId: string;
  readonly quantity: number;
  readonly customerId: string;
  readonly delivery: {
    readonly recipientName: string;
    readonly phone: string;
    readonly addressLine1: string;
    readonly addressLine2?: string;
    readonly city: string;
    readonly department: string;
    readonly postalCode?: string;
  };
  readonly payment: {
    /** Held in this in-memory object for the gateway call only. Never stored, logged or returned. */
    readonly cardToken: string;
    readonly installments: number;
    readonly brand: CardBrand;
    readonly lastFour: string;
  };
  readonly acceptanceToken: string;
  /** Personal-data authorization token. */
  readonly acceptPersonalAuth: string;
}

export interface CreateTransactionInput {
  /** Raw `Idempotency-Key` header value; `undefined` when the header is absent. */
  readonly idempotencyKey: string | undefined;
  readonly request: CreateTransactionRequest;
}

/** The HTTP status and JSON body the controller must send as they are. */
export interface CreateTransactionOutput {
  readonly statusCode: number;
  readonly body: unknown;
}

/**
 * Stored in the idempotency record and returned for a rejected first attempt, so a replay
 * answers exactly what the first request answered. Must stay equal to the catalog envelope
 * of `PAYMENT_PROVIDER_ERROR` (the application layer cannot import the catalog).
 */
export const PAYMENT_PROVIDER_ERROR_BODY = {
  statusCode: 502,
  code: 'PAYMENT_PROVIDER_ERROR',
  message: 'The payment provider could not process the request.',
  details: [],
} as const;

interface Plan {
  readonly product: Product;
  readonly customer: Customer;
  readonly amounts: Amounts;
  readonly transactionId: string;
  readonly deliveryId: string;
  readonly reference: Reference;
}

type GatewayAttempt =
  | { readonly kind: 'answered'; readonly response: PaymentCreateResponse }
  | { readonly kind: 'failed'; readonly error: PaymentGatewayError };

export class CreateTransaction {
  constructor(
    private readonly idempotency: IdempotencyRepository,
    private readonly products: ProductRepository,
    private readonly customers: CustomerRepository,
    private readonly transactions: TransactionRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly gateway: Pick<PaymentGateway, 'create'>,
    private readonly finalizeTransaction: FinalizeTransaction,
    private readonly fees: FeeSchedule,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: ApplicationLogger,
  ) {}

  execute(
    input: CreateTransactionInput,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    const key = validateKey(input.idempotencyKey);
    if (key.isErr()) {
      return errAsync(key.error);
    }
    const hash = requestHash(toJson(input.request));
    return this.begin(key.value, hash, input.request, 0);
  }

  /** Steps 4 and 5. `attempt` is 1 after the single retry that follows a lost takeover race. */
  private begin(
    key: string,
    hash: string,
    request: CreateTransactionRequest,
    attempt: number,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    return this.idempotency
      .begin(key, hash, this.clock.now())
      .andThen((outcome) => this.onBegin(outcome, key, hash, request, attempt));
  }

  private onBegin(
    outcome: BeginOutcome,
    key: string,
    hash: string,
    request: CreateTransactionRequest,
    attempt: number,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    switch (outcome.kind) {
      case 'created':
        return this.process(key, request);
      case 'hash_mismatch':
        return errAsync({ kind: 'IDEMPOTENCY_KEY_REUSED' });
      case 'in_progress_fresh':
        return errAsync({ kind: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
      case 'completed':
        return okAsync({
          statusCode: outcome.statusCode === 201 ? 200 : outcome.statusCode,
          body: outcome.body,
        });
      case 'in_progress_stale':
        if (outcome.transactionId !== null) {
          return this.currentState(outcome.transactionId);
        }
        return this.idempotency.takeOver(key, outcome.createdAt).andThen((taken) => {
          if (taken === 'taken') {
            return this.process(key, request);
          }
          // Another invocation took the record first: look again once, then report in progress.
          return attempt === 0
            ? this.begin(key, hash, request, attempt + 1)
            : errAsync<CreateTransactionOutput, CreateTransactionError>({
                kind: 'IDEMPOTENCY_KEY_IN_PROGRESS',
              });
        });
    }
  }

  /** Requirement 6.9: a stale record that already holds a Transaction answers its current state. */
  private currentState(
    transactionId: string,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    return this.transactions.findById(transactionId).andThen((transaction) =>
      transaction === null
        ? errAsync<CreateTransactionOutput, CreateTransactionError>({
            kind: 'REPOSITORY_ERROR',
            reason: 'IdempotencyTransactionMissing',
          })
        : okAsync<CreateTransactionOutput, CreateTransactionError>({
            statusCode: 200,
            body: toTransactionResponse(transaction),
          }),
    );
  }

  /** Step 6 and 7 (releasing the key on failure), then steps 8 to 14. */
  private process(
    key: string,
    request: CreateTransactionRequest,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    return this.prepare(request)
      .orElse((error) => this.releaseThen(key, error))
      .andThen((plan) => this.persist(key, request, plan))
      .andThen((output) => this.complete(key, output));
  }

  /**
   * The payment is already settled here, so a failure to store the replay body must not turn the
   * answer into an error: the client gets the real result and a replay falls back to the stored
   * Transaction state.
   */
  private complete(
    key: string,
    output: CreateTransactionOutput,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    return this.idempotency
      .complete(key, output.statusCode, output.body)
      .orElse((error) => {
        this.logger.warn('idempotency record could not be completed', { reason: error.reason });
        return okAsync<void, never>(undefined);
      })
      .map(() => output);
  }

  /** Product, customer and stock checks, then the amounts and the new ids. Nothing is written. */
  private prepare(request: CreateTransactionRequest): ResultAsync<Plan, CreateTransactionError> {
    return this.products
      .findById(request.productId)
      .andThen((product) =>
        product === null
          ? errAsync<Product, CreateTransactionError>({ kind: 'PRODUCT_NOT_FOUND' })
          : okAsync<Product, CreateTransactionError>(product),
      )
      .andThen((product) =>
        this.customers
          .findById(request.customerId)
          .andThen((customer) =>
            customer === null
              ? errAsync<Plan, CreateTransactionError>({ kind: 'CUSTOMER_NOT_FOUND' })
              : this.plan(product, customer, request.quantity),
          ),
      );
  }

  private plan(product: Product, customer: Customer, quantity: number): Result<Plan, DomainError> {
    if (product.stock < quantity) {
      return err({ kind: 'INSUFFICIENT_STOCK', available: product.stock });
    }
    return computeAmounts(
      product.priceInCents,
      quantity,
      this.fees.baseFeeInCents,
      this.fees.deliveryFeeInCents,
    ).andThen((amounts) =>
      createReference(this.ids.ulid()).map((reference): Plan => ({
        product,
        customer,
        amounts,
        transactionId: this.ids.ulid(),
        deliveryId: this.ids.ulid(),
        reference,
      })),
    );
  }

  /** Requirement 6.11: the record is deleted only when nothing has been written yet. */
  private releaseThen(
    key: string,
    error: CreateTransactionError,
  ): ResultAsync<never, CreateTransactionError> {
    return this.idempotency
      .release(key)
      .orElse((releaseError) => {
        this.logger.warn('idempotency record could not be released', {
          reason: releaseError.reason,
        });
        return okAsync<void, never>(undefined);
      })
      .andThen(() => errAsync<never, CreateTransactionError>(error));
  }

  /** Steps 8 to 12: Delivery PENDING, Transaction PENDING, attach the id, charge, apply the result. */
  private persist(
    key: string,
    request: CreateTransactionRequest,
    plan: Plan,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    const at = this.clock.now().toISOString();
    return this.deliveries
      .create(newDelivery(request, plan, at))
      .andThen(() => this.transactions.create(newTransaction(request, plan, at)))
      .andThen((transaction) =>
        this.idempotency.attachTransactionId(key, transaction.id).map(() => transaction),
      )
      .andThen((transaction) => this.charge(transaction, request, plan.customer));
  }

  /** Step 11 and 12. `create` is called exactly once here; the adapter owns the single retry. */
  private charge(
    transaction: Transaction,
    request: CreateTransactionRequest,
    customer: Customer,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    const paymentRequest: PaymentCreateRequest = {
      reference: transaction.reference,
      amountInCents: transaction.totalInCents,
      currency: transaction.currency,
      customerEmail: customer.email,
      acceptanceToken: request.acceptanceToken,
      acceptPersonalAuth: request.acceptPersonalAuth,
      cardToken: request.payment.cardToken,
      installments: request.payment.installments,
    };
    return this.gateway
      .create(paymentRequest)
      .map((response): GatewayAttempt => ({ kind: 'answered', response }))
      .orElse((error) => okAsync<GatewayAttempt, never>({ kind: 'failed', error }))
      .andThen((attempt) =>
        attempt.kind === 'answered'
          ? this.applyResponse(transaction, attempt.response)
          : this.applyFailure(transaction, attempt.error),
      );
  }

  /**
   * The provider accepted the request, so a charge exists. A repository failure from here on must
   * not turn into an error response: the Transaction stays PENDING and a later GET reconciles it.
   */
  private applyResponse(
    transaction: Transaction,
    response: PaymentCreateResponse,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    return this.transactions
      .setExternalId(transaction.id, response.externalId)
      .andThen(() => {
        const stored: Transaction = { ...transaction, externalId: response.externalId };
        return isFinalStatus(response.status)
          ? this.finalizeTransaction.execute(stored, {
              source: 'provider',
              status: response.status as FinalStatus,
              ...reasonFor(response),
              report: {
                amountInCents: response.amountInCents,
                currency: response.currency,
                reference: response.reference,
              },
            })
          : okAsync<Transaction, RepositoryError>(stored);
      })
      .orElse((error) => {
        this.logger.warn('provider accepted the payment but the result could not be stored', {
          reference: transaction.reference,
          reason: error.reason,
        });
        return okAsync<Transaction, never>(transaction);
      })
      .map((result) => created(result));
  }

  private applyFailure(
    transaction: Transaction,
    error: PaymentGatewayError,
  ): ResultAsync<CreateTransactionOutput, CreateTransactionError> {
    if (error.kind === 'REJECTED' && !error.afterTransientFailure) {
      // A clean 4xx on the first attempt: nothing was charged. `providerMessage` is already a short code.
      return this.finalizeTransaction
        .execute(transaction, {
          source: 'internal',
          status: 'ERROR',
          statusReason: error.providerMessage,
        })
        .map((): CreateTransactionOutput => ({
          statusCode: PAYMENT_PROVIDER_ERROR_BODY.statusCode,
          body: PAYMENT_PROVIDER_ERROR_BODY,
        }));
    }
    // REJECTED after a transient failure, UNAVAILABLE and INVALID_RESPONSE: the provider may have
    // created the payment, so stay PENDING without reconciling or calling again (Requirements 7.7, 8.1).
    this.logger.warn('payment creation left pending without external id', {
      reference: transaction.reference,
      failure: error.kind,
    });
    return okAsync(created(transaction));
  }
}

/** DECLINED, VOIDED and ERROR keep a cleaned copy of the provider message; APPROVED has none. */
function reasonFor(response: PaymentCreateResponse): { statusReason?: string } {
  const reason = response.status === 'APPROVED' ? undefined : providerReason(response.message);
  return reason === undefined ? {} : { statusReason: reason };
}

function created(transaction: Transaction): CreateTransactionOutput {
  return { statusCode: 201, body: toTransactionResponse(transaction) };
}

function validateKey(key: string | undefined): Result<string, ApplicationError> {
  if (key === undefined || key.length === 0) {
    return err({ kind: 'MISSING_IDEMPOTENCY_KEY' });
  }
  return IDEMPOTENCY_KEY_PATTERN.test(key)
    ? ok(key)
    : err({
        kind: 'VALIDATION_ERROR',
        details: [{ field: IDEMPOTENCY_KEY_FIELD, rule: IDEMPOTENCY_KEY_RULE }],
      });
}

/** Drops `undefined` members so equal bodies hash equally whatever the DTO instance looks like. */
function toJson(request: CreateTransactionRequest): JsonValue {
  return JSON.parse(JSON.stringify(request)) as JsonValue;
}

function newDelivery(request: CreateTransactionRequest, plan: Plan, at: string): NewDelivery {
  const { delivery } = request;
  return {
    id: plan.deliveryId,
    transactionId: plan.transactionId,
    productId: plan.product.id,
    quantity: request.quantity,
    recipientName: delivery.recipientName,
    phone: delivery.phone,
    addressLine1: delivery.addressLine1,
    ...(delivery.addressLine2 === undefined ? {} : { addressLine2: delivery.addressLine2 }),
    city: delivery.city,
    department: delivery.department,
    ...(delivery.postalCode === undefined ? {} : { postalCode: delivery.postalCode }),
    createdAt: at,
  } satisfies Omit<Delivery, 'status' | 'updatedAt'>;
}

function newTransaction(request: CreateTransactionRequest, plan: Plan, at: string): NewTransaction {
  return {
    id: plan.transactionId,
    reference: plan.reference,
    productId: plan.product.id,
    quantity: request.quantity,
    customerId: plan.customer.id,
    deliveryId: plan.deliveryId,
    unitPriceInCents: plan.product.priceInCents,
    subtotalInCents: plan.amounts.subtotalInCents,
    baseFeeInCents: plan.amounts.baseFeeInCents,
    deliveryFeeInCents: plan.amounts.deliveryFeeInCents,
    totalInCents: plan.amounts.totalInCents,
    currency: plan.amounts.currency,
    installments: request.payment.installments,
    cardBrand: request.payment.brand,
    cardLastFour: request.payment.lastFour,
    createdAt: at,
  };
}
