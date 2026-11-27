import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import type { RepositoryError } from '../../application/errors';
import type {
  CustomerRepository,
  UpsertCustomerInput,
  UpsertCustomerResult,
} from '../../application/ports/customer-repository';
import type { Customer } from '../../domain/entities';

// DynamoDB rejects an empty key and any key larger than 2048 bytes. Such ids cannot match a customer.
const MAX_KEY_BYTES = 2048;

// Global secondary index on the `email` attribute. Queries on a GSI cannot be strongly consistent.
const EMAIL_INDEX = 'email';

// Unknown attributes are stripped by default, so the mapped Customer keeps the exact field set.
const customerItemSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  fullName: z.string(),
  phone: z.string(),
  documentType: z.enum(['CC', 'CE', 'NIT', 'PP']),
  documentNumber: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class DynamoCustomerRepository implements CustomerRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  findByEmail(normalizedEmail: string): ResultAsync<Customer | null, RepositoryError> {
    return ResultAsync.fromPromise(this.queryByEmail(normalizedEmail), toRepositoryError);
  }

  findById(id: string): ResultAsync<Customer | null, RepositoryError> {
    if (!canMatchAKey(id)) {
      return okAsync<Customer | null, RepositoryError>(null);
    }
    return ResultAsync.fromPromise(this.getOne(id), toRepositoryError);
  }

  upsert(input: UpsertCustomerInput): ResultAsync<UpsertCustomerResult, RepositoryError> {
    return ResultAsync.fromPromise(this.upsertOne(input), toRepositoryError);
  }

  private async queryByEmail(normalizedEmail: string): Promise<Customer | null> {
    const { Items } = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: EMAIL_INDEX,
        KeyConditionExpression: '#email = :email',
        ExpressionAttributeNames: { '#email': 'email' },
        ExpressionAttributeValues: { ':email': normalizedEmail },
        Limit: 1,
      }),
    );
    const [item] = Items ?? [];
    return item === undefined ? null : toCustomer(item);
  }

  private async getOne(id: string): Promise<Customer | null> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { id }, ConsistentRead: true }),
    );
    return Item === undefined ? null : toCustomer(Item);
  }

  private async upsertOne(input: UpsertCustomerInput): Promise<UpsertCustomerResult> {
    const existing = await this.queryByEmail(input.email);
    if (existing === null) {
      return this.insert(input);
    }
    return this.update(existing.id, input);
  }

  private async insert(input: UpsertCustomerInput): Promise<UpsertCustomerResult> {
    const customer = {
      id: input.id,
      email: input.email,
      fullName: input.fullName,
      phone: input.phone,
      documentType: input.documentType,
      documentNumber: input.documentNumber,
      createdAt: input.at,
      updatedAt: input.at,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: customer,
        ConditionExpression: 'attribute_not_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id' },
      }),
    );
    return { customer, created: true };
  }

  // `email` and `createdAt` are never written here: the email is the GSI key of the existing
  // item and `createdAt` keeps the original instant.
  private async update(id: string, input: UpsertCustomerInput): Promise<UpsertCustomerResult> {
    const { Attributes } = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id },
        UpdateExpression:
          'SET #fullName = :fullName, #phone = :phone, #documentType = :documentType, #documentNumber = :documentNumber, #updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(#id)',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#fullName': 'fullName',
          '#phone': 'phone',
          '#documentType': 'documentType',
          '#documentNumber': 'documentNumber',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':fullName': input.fullName,
          ':phone': input.phone,
          ':documentType': input.documentType,
          ':documentNumber': input.documentNumber,
          ':updatedAt': input.at,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return { customer: toCustomer(Attributes ?? {}), created: false };
  }
}

function canMatchAKey(id: string): boolean {
  return id.length > 0 && Buffer.byteLength(id, 'utf8') <= MAX_KEY_BYTES;
}

function toCustomer(item: Record<string, unknown>): Customer {
  return customerItemSchema.parse(item);
}

// Only the exception class name leaves the adapter: never the SDK message, stack or item data.
function toRepositoryError(error: unknown): RepositoryError {
  return {
    kind: 'REPOSITORY_ERROR',
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
  };
}
