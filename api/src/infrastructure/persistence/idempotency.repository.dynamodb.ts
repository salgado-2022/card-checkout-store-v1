import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';
import type { RepositoryError } from '../../application/errors';
import type { Clock } from '../../application/ports/clock';
import type {
  BeginOutcome,
  IdempotencyRepository,
} from '../../application/ports/idempotency-repository';
// Equals the Lambda timeout: a record is stale only once its owner invocation can no longer run.
const STALE_AFTER_MS = 25_000;
// Requirement 6.12: the TTL attribute `expiresAt` is 24 h after creation, in epoch seconds.
const RECORD_TTL_SECONDS = 24 * 60 * 60;
// `begin` re-reads once when the record disappears between the failed put and the read
// (a concurrent `release`). A second disappearance is reported as a repository error.
const MAX_BEGIN_ATTEMPTS = 2;
// Never holds a card token or card data: only the hash, the state and the stored response.
const idempotencyItemSchema = z.object({
  requestHash: z.string(),
  state: z.enum(['IN_PROGRESS', 'COMPLETED']),
  createdAt: z.string(),
  transactionId: z.string().optional(),
  responseStatusCode: z.number().optional(),
  responseBody: z.unknown().optional(),
});
type IdempotencyItem = z.infer<typeof idempotencyItemSchema>;
class RecordVanishedError extends Error {}
export class DynamoIdempotencyRepository implements IdempotencyRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly clock: Clock,
  ) {}
  begin(key: string, requestHash: string, now: Date): ResultAsync<BeginOutcome, RepositoryError> {
    return ResultAsync.fromPromise(this.beginOne(key, requestHash, now, 1), toRepositoryError);
  }
  attachTransactionId(key: string, transactionId: string): ResultAsync<void, RepositoryError> {
    return ResultAsync.fromPromise(
      this.client
        .send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { key },
            UpdateExpression: 'SET #transactionId = :transactionId',
            ConditionExpression: 'attribute_exists(#key)',
            ExpressionAttributeNames: { '#key': 'key', '#transactionId': 'transactionId' },
            ExpressionAttributeValues: { ':transactionId': transactionId },
          }),
        )
        .then(() => undefined),
      toRepositoryError,
    );
  }
  complete(key: string, statusCode: number, body: unknown): ResultAsync<void, RepositoryError> {
    return ResultAsync.fromPromise(
      this.client
        .send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { key },
            UpdateExpression:
              'SET #state = :completed, #responseStatusCode = :statusCode, #responseBody = :body',
            ConditionExpression: 'attribute_exists(#key)',
            ExpressionAttributeNames: {
              '#key': 'key',
              '#state': 'state',
              '#responseStatusCode': 'responseStatusCode',
              '#responseBody': 'responseBody',
            },
            ExpressionAttributeValues: {
              ':completed': 'COMPLETED',
              ':statusCode': statusCode,
              ':body': body,
            },
          }),
        )
        .then(() => undefined),
      toRepositoryError,
    );
  }
  release(key: string): ResultAsync<void, RepositoryError> {
    return ResultAsync.fromPromise(
      this.client
        .send(new DeleteCommand({ TableName: this.tableName, Key: { key } }))
        .then(() => undefined),
      toRepositoryError,
    );
  }
  takeOver(
    key: string,
    previousCreatedAt: string,
  ): ResultAsync<'taken' | 'lost_race', RepositoryError> {
    return ResultAsync.fromPromise(this.takeOverOne(key, previousCreatedAt), toRepositoryError);
  }
  private async beginOne(
    key: string,
    requestHash: string,
    now: Date,
    attempt: number,
  ): Promise<BeginOutcome> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            key,
            requestHash,
            state: 'IN_PROGRESS',
            createdAt: now.toISOString(),
            expiresAt: expiresAtFrom(now),
          },
          ConditionExpression: 'attribute_not_exists(#key)',
          ExpressionAttributeNames: { '#key': 'key' },
        }),
      );
      return { kind: 'created' };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
    const existing = await this.readExisting(key);
    if (existing !== null) {
      return this.classify(existing, requestHash);
    }
    if (attempt >= MAX_BEGIN_ATTEMPTS) {
      throw new RecordVanishedError();
    }
    return this.beginOne(key, requestHash, now, attempt + 1);
  }
  private async readExisting(key: string): Promise<IdempotencyItem | null> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { key }, ConsistentRead: true }),
    );
    return Item === undefined ? null : idempotencyItemSchema.parse(Item);
  }
  private classify(existing: IdempotencyItem, requestHash: string): BeginOutcome {
    if (existing.requestHash !== requestHash) {
      return { kind: 'hash_mismatch' };
    }
    if (existing.state === 'COMPLETED') {
      return {
        kind: 'completed',
        statusCode: existing.responseStatusCode ?? 0,
        body: existing.responseBody,
      };
    }
    const ageInMs = this.clock.now().getTime() - new Date(existing.createdAt).getTime();
    if (ageInMs < STALE_AFTER_MS) {
      return { kind: 'in_progress_fresh' };
    }
    return {
      kind: 'in_progress_stale',
      transactionId: existing.transactionId ?? null,
      createdAt: existing.createdAt,
    };
  }
  // Only a record that is still IN_PROGRESS, has no transaction id and keeps the previous
  // `createdAt` can be taken over, so two concurrent takers cannot both win (Requirement 6.10).
  private async takeOverOne(
    key: string,
    previousCreatedAt: string,
  ): Promise<'taken' | 'lost_race'> {
    const now = this.clock.now();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { key },
          UpdateExpression: 'SET #createdAt = :now, #expiresAt = :expiresAt',
          ConditionExpression:
            '#state = :inProgress AND #createdAt = :previousCreatedAt AND attribute_not_exists(#transactionId)',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#createdAt': 'createdAt',
            '#expiresAt': 'expiresAt',
            '#transactionId': 'transactionId',
          },
          ExpressionAttributeValues: {
            ':now': now.toISOString(),
            ':expiresAt': expiresAtFrom(now),
            ':inProgress': 'IN_PROGRESS',
            ':previousCreatedAt': previousCreatedAt,
          },
        }),
      );
      return 'taken';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'lost_race';
      }
      throw error;
    }
  }
}
function expiresAtFrom(createdAt: Date): number {
  return Math.floor(createdAt.getTime() / 1000) + RECORD_TTL_SECONDS;
}
// Only the exception class name leaves the adapter: never the SDK message, stack or item data.
function toRepositoryError(error: unknown): RepositoryError {
  return {
    kind: 'REPOSITORY_ERROR',
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
  };
}
