import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import type { RepositoryError } from '../../application/errors';
import type {
  FinalizeInput,
  FinalizeOutcome,
  NewTransaction,
  TransactionRepository,
} from '../../application/ports/transaction-repository';
import { CARD_BRANDS } from '../../domain/card-brand';
import type { Transaction } from '../../domain/entities';
import { TRANSACTION_STATUSES } from '../../domain/transaction-status';

// DynamoDB rejects an empty key and any key larger than 2048 bytes. Such ids cannot match a transaction.
const MAX_KEY_BYTES = 2048;

// Global secondary index on the `reference` attribute. Queries on a GSI cannot be strongly consistent.
const REFERENCE_INDEX = 'reference';

// Unknown attributes are stripped by default, so a stored card token or card number never reaches the caller.
const transactionItemSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  status: z.enum(TRANSACTION_STATUSES),
  statusReason: z.string().optional(),
  productId: z.string().min(1),
  quantity: z.number().int(),
  customerId: z.string().min(1),
  deliveryId: z.string().min(1),
  unitPriceInCents: z.number().int().nonnegative(),
  subtotalInCents: z.number().int().nonnegative(),
  baseFeeInCents: z.number().int().nonnegative(),
  deliveryFeeInCents: z.number().int().nonnegative(),
  totalInCents: z.number().int().nonnegative(),
  currency: z.string(),
  installments: z.number().int(),
  cardBrand: z.enum(CARD_BRANDS),
  cardLastFour: z.string(),
  externalId: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finalizedAt: z.string().optional(),
});

// The tables `finalize` writes besides the Transactions table, in one TransactWriteItems.
export interface FinalizeTables {
  readonly deliveries: string;
  readonly products: string;
}
// Position of each item in the TransactWriteItems list: CancellationReasons are read by position.
const TRANSACTION_ITEM = 0;
const DELIVERY_ITEM = 1;
const PRODUCT_ITEM = 2;
const CONDITION_FAILED = 'ConditionalCheckFailed';
export class DynamoTransactionRepository implements TransactionRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly tables: FinalizeTables,
  ) {}

  findById(id: string): ResultAsync<Transaction | null, RepositoryError> {
    if (!canMatchAKey(id)) {
      return okAsync<Transaction | null, RepositoryError>(null);
    }
    return ResultAsync.fromPromise(this.getOne(id), toRepositoryError);
  }

  findByReference(reference: string): ResultAsync<Transaction | null, RepositoryError> {
    if (reference.length === 0) {
      return okAsync<Transaction | null, RepositoryError>(null);
    }
    return ResultAsync.fromPromise(this.queryByReference(reference), toRepositoryError);
  }

  create(input: NewTransaction): ResultAsync<Transaction, RepositoryError> {
    return ResultAsync.fromPromise(this.insert(input), toRepositoryError);
  }

  setExternalId(id: string, externalId: string): ResultAsync<void, RepositoryError> {
    return ResultAsync.fromPromise(this.updateExternalId(id, externalId), toRepositoryError);
  }

  setLastSynced(id: string, at: Date): ResultAsync<void, RepositoryError> {
    return ResultAsync.fromPromise(this.updateLastSynced(id, at), toRepositoryError);
  }

  // Refuses inputs that would corrupt the stock before touching DynamoDB: a quantity that is not a
  // positive integer would decrement it wrongly, and ASSIGNED decrements it, so only an APPROVED
  // transaction may carry it.
  finalize(input: FinalizeInput): ResultAsync<FinalizeOutcome, RepositoryError> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      return errAsync({ kind: 'REPOSITORY_ERROR', reason: 'InvalidFinalizationQuantity' });
    }
    if (input.deliveryStatus === 'ASSIGNED' && input.status !== 'APPROVED') {
      return errAsync({ kind: 'REPOSITORY_ERROR', reason: 'InvalidFinalizationStatus' });
    }
    return ResultAsync.fromPromise(this.applyFinalization(input), toRepositoryError);
  }

  // One TransactWriteItems. The unconditional read first gives the stored state to return and spares
  // the write when the transaction is already final. The conditions still guard against a race.
  private async applyFinalization(input: FinalizeInput): Promise<FinalizeOutcome> {
    const current = await this.getOne(input.transactionId);
    if (current === null) {
      throw new TransactionNotFoundError();
    }
    if (current.status !== 'PENDING') {
      return { kind: 'already_final', transaction: current };
    }
    try {
      await this.client.send(new TransactWriteCommand(this.buildFinalization(input)));
    } catch (error) {
      return this.interpretCancellation(error, input);
    }
    return { kind: 'applied', transaction: finalizedTransaction(current, input) };
  }
  private async interpretCancellation(
    error: unknown,
    input: FinalizeInput,
  ): Promise<FinalizeOutcome> {
    if (!(error instanceof TransactionCanceledException)) {
      throw error;
    }
    const failed = (position: number): boolean =>
      error.CancellationReasons?.[position]?.Code === CONDITION_FAILED;
    if (failed(TRANSACTION_ITEM)) {
      const stored = await this.getOne(input.transactionId);
      if (stored === null || stored.status === 'PENDING') {
        throw new FinalizationConflictError();
      }
      return { kind: 'already_final', transaction: stored };
    }
    if (input.deliveryStatus === 'ASSIGNED' && failed(PRODUCT_ITEM) && !failed(DELIVERY_ITEM)) {
      return { kind: 'stock_unavailable' };
    }
    throw error;
  }
  private buildFinalization(input: FinalizeInput): TransactWriteCommandInput {
    const reason = input.statusReason;
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Update: {
          TableName: this.tableName,
          Key: { id: input.transactionId },
          UpdateExpression:
            reason === undefined
              ? 'SET #status = :status, #finalizedAt = :at, #updatedAt = :at'
              : 'SET #status = :status, #statusReason = :reason, #finalizedAt = :at, #updatedAt = :at',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#finalizedAt': 'finalizedAt',
            '#updatedAt': 'updatedAt',
            ...(reason === undefined ? {} : { '#statusReason': 'statusReason' }),
          },
          ExpressionAttributeValues: {
            ':status': input.status,
            ':pending': 'PENDING',
            ':at': input.at,
            ...(reason === undefined ? {} : { ':reason': reason }),
          },
        },
      },
      {
        Update: {
          TableName: this.tables.deliveries,
          Key: { id: input.deliveryId },
          UpdateExpression: 'SET #status = :status, #updatedAt = :at',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: {
            ':status': input.deliveryStatus,
            ':pending': 'PENDING',
            ':at': input.at,
          },
        },
      },
    ];
    if (input.deliveryStatus === 'ASSIGNED') {
      items.push({
        Update: {
          TableName: this.tables.products,
          Key: { id: input.productId },
          UpdateExpression: 'SET #stock = #stock - :quantity',
          ConditionExpression: '#stock >= :quantity',
          ExpressionAttributeNames: { '#stock': 'stock' },
          ExpressionAttributeValues: { ':quantity': input.quantity },
        },
      });
    }
    return { TransactItems: items };
  }
  private async getOne(id: string): Promise<Transaction | null> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { id }, ConsistentRead: true }),
    );
    return Item === undefined ? null : toTransaction(Item);
  }

  private async queryByReference(reference: string): Promise<Transaction | null> {
    const { Items } = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: REFERENCE_INDEX,
        KeyConditionExpression: '#reference = :reference',
        ExpressionAttributeNames: { '#reference': 'reference' },
        ExpressionAttributeValues: { ':reference': reference },
        Limit: 1,
      }),
    );
    const [item] = Items ?? [];
    return item === undefined ? null : toTransaction(item);
  }

  // Fields are picked one by one so that no card data passed by mistake is ever persisted.
  // Only the card brand and the last four digits are stored.
  private async insert(input: NewTransaction): Promise<Transaction> {
    const transaction: Transaction = {
      id: input.id,
      reference: input.reference,
      status: 'PENDING',
      productId: input.productId,
      quantity: input.quantity,
      customerId: input.customerId,
      deliveryId: input.deliveryId,
      unitPriceInCents: input.unitPriceInCents,
      subtotalInCents: input.subtotalInCents,
      baseFeeInCents: input.baseFeeInCents,
      deliveryFeeInCents: input.deliveryFeeInCents,
      totalInCents: input.totalInCents,
      currency: input.currency,
      installments: input.installments,
      cardBrand: input.cardBrand,
      cardLastFour: input.cardLastFour,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: transaction,
        ConditionExpression: 'attribute_not_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id' },
      }),
    );
    return transaction;
  }

  // The condition stops an UpdateItem from creating a partial item for an unknown id.
  private async updateExternalId(id: string, externalId: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id },
        UpdateExpression: 'SET #externalId = :externalId',
        ConditionExpression: 'attribute_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id', '#externalId': 'externalId' },
        ExpressionAttributeValues: { ':externalId': externalId },
      }),
    );
  }

  private async updateLastSynced(id: string, at: Date): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id },
        UpdateExpression: 'SET #lastSyncedAt = :lastSyncedAt',
        ConditionExpression: 'attribute_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id', '#lastSyncedAt': 'lastSyncedAt' },
        ExpressionAttributeValues: { ':lastSyncedAt': at.toISOString() },
      }),
    );
  }
}

function finalizedTransaction(current: Transaction, input: FinalizeInput): Transaction {
  return {
    ...current,
    status: input.status,
    ...(input.statusReason === undefined ? {} : { statusReason: input.statusReason }),
    finalizedAt: input.at,
    updatedAt: input.at,
  };
}
// Internal failures of `finalize`: they surface as REPOSITORY_ERROR with the class name only.
class TransactionNotFoundError extends Error {}
class FinalizationConflictError extends Error {}
function canMatchAKey(id: string): boolean {
  return id.length > 0 && Buffer.byteLength(id, 'utf8') <= MAX_KEY_BYTES;
}

function toTransaction(item: Record<string, unknown>): Transaction {
  return transactionItemSchema.parse(item);
}

// Only the exception class name leaves the adapter: never the SDK message, stack or item data.
function toRepositoryError(error: unknown): RepositoryError {
  return {
    kind: 'REPOSITORY_ERROR',
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
  };
}
