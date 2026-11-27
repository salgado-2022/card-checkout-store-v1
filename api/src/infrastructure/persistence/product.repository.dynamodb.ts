import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import type { RepositoryError } from '../../application/errors';
import type { ProductRepository } from '../../application/ports/product-repository';
import type { Product } from '../../domain/entities';

// DynamoDB rejects an empty key and any key larger than 2048 bytes. Such ids cannot match a product.
const MAX_KEY_BYTES = 2048;

// Unknown attributes are stripped by default, so the mapped Product keeps the exact field set.
const productItemSchema = z.object({
  id: z.string().min(1),
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  imageUrl: z.string(),
  priceInCents: z.number().int().nonnegative(),
  currency: z.string(),
  stock: z.number().int().nonnegative(),
});

export class DynamoProductRepository implements ProductRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  findAll(): ResultAsync<readonly Product[], RepositoryError> {
    return ResultAsync.fromPromise(this.scanAll(), toRepositoryError);
  }

  findById(id: string): ResultAsync<Product | null, RepositoryError> {
    if (!canMatchAKey(id)) {
      return okAsync<Product | null, RepositoryError>(null);
    }
    return ResultAsync.fromPromise(this.getOne(id), toRepositoryError);
  }

  private async scanAll(): Promise<Product[]> {
    const products: Product[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      products.push(...(page.Items ?? []).map(toProduct));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return products;
  }

  private async getOne(id: string): Promise<Product | null> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { id }, ConsistentRead: true }),
    );
    return Item === undefined ? null : toProduct(Item);
  }
}

function canMatchAKey(id: string): boolean {
  return id.length > 0 && Buffer.byteLength(id, 'utf8') <= MAX_KEY_BYTES;
}

function toProduct(item: Record<string, unknown>): Product {
  return productItemSchema.parse(item);
}

// Only the exception class name leaves the adapter: never the SDK message, stack or item data.
function toRepositoryError(error: unknown): RepositoryError {
  return {
    kind: 'REPOSITORY_ERROR',
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
  };
}
