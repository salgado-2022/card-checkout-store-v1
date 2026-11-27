import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import type { RepositoryError } from '../../application/errors';
import type { DeliveryRepository, NewDelivery } from '../../application/ports/delivery-repository';
import { DELIVERY_STATUSES } from '../../domain/delivery-status';
import type { Delivery } from '../../domain/entities';

// DynamoDB rejects an empty key and any key larger than 2048 bytes. Such ids cannot match a delivery.
const MAX_KEY_BYTES = 2048;

// Unknown attributes are stripped by default, so the mapped Delivery keeps the exact field set.
const deliveryItemSchema = z.object({
  id: z.string().min(1),
  transactionId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int(),
  recipientName: z.string(),
  phone: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  department: z.string(),
  postalCode: z.string().optional(),
  status: z.enum(DELIVERY_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class DynamoDeliveryRepository implements DeliveryRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  findById(id: string): ResultAsync<Delivery | null, RepositoryError> {
    if (!canMatchAKey(id)) {
      return okAsync<Delivery | null, RepositoryError>(null);
    }
    return ResultAsync.fromPromise(this.getOne(id), toRepositoryError);
  }

  create(input: NewDelivery): ResultAsync<Delivery, RepositoryError> {
    return ResultAsync.fromPromise(this.insert(input), toRepositoryError);
  }

  private async getOne(id: string): Promise<Delivery | null> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { id }, ConsistentRead: true }),
    );
    return Item === undefined ? null : toDelivery(Item);
  }

  // Fields are picked one by one so that no unexpected input attribute is ever persisted.
  private async insert(input: NewDelivery): Promise<Delivery> {
    const delivery: Delivery = {
      id: input.id,
      transactionId: input.transactionId,
      productId: input.productId,
      quantity: input.quantity,
      recipientName: input.recipientName,
      phone: input.phone,
      addressLine1: input.addressLine1,
      ...optionalField('addressLine2', input.addressLine2),
      city: input.city,
      department: input.department,
      ...optionalField('postalCode', input.postalCode),
      status: 'PENDING',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: delivery,
        ConditionExpression: 'attribute_not_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id' },
      }),
    );
    return delivery;
  }
}

function optionalField<K extends string>(
  name: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, string>);
}

function canMatchAKey(id: string): boolean {
  return id.length > 0 && Buffer.byteLength(id, 'utf8') <= MAX_KEY_BYTES;
}

function toDelivery(item: Record<string, unknown>): Delivery {
  return deliveryItemSchema.parse(item);
}

// Only the exception class name leaves the adapter: never the SDK message, stack or item data.
function toRepositoryError(error: unknown): RepositoryError {
  return {
    kind: 'REPOSITORY_ERROR',
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
  };
}
