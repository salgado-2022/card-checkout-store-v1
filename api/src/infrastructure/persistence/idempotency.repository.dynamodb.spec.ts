import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { FakeClock } from '../../../test/support/fake-clock';
import { DynamoIdempotencyRepository } from './idempotency.repository.dynamodb';

const TABLE = 'test-idempotency-keys';
const idemKeyValue = 'test-key-0001';
const HASH = 'hash-a';
const START = '2026-01-15T10:00:00.000Z';
const START_SECONDS = Date.parse(START) / 1000;
const DAY_SECONDS = 86_400;

class ThrottlingFailure extends Error {}

function conditionFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ message: 'condition detail', $metadata: {} });
}

function inProgressItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: idemKeyValue,
    requestHash: HASH,
    state: 'IN_PROGRESS',
    createdAt: START,
    expiresAt: START_SECONDS + DAY_SECONDS,
    ...overrides,
  };
}

describe('DynamoIdempotencyRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const clock = new FakeClock(START);
  const repository = new DynamoIdempotencyRepository(client, TABLE, clock);

  beforeEach(() => {
    clock.set(START);
  });

  afterEach(() => {
    ddbMock.reset();
  });

  describe('begin', () => {
    it('puts an IN_PROGRESS record guarded by attribute_not_exists and returns created', async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrap()).toEqual({ kind: 'created' });
      const [call] = ddbMock.commandCalls(PutCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Item: {
          key: idemKeyValue,
          requestHash: HASH,
          state: 'IN_PROGRESS',
          createdAt: START,
          expiresAt: START_SECONDS + DAY_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(#key)',
        ExpressionAttributeNames: { '#key': 'key' },
      });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('sets expiresAt to 24 h after creation as epoch seconds, dropping milliseconds', async () => {
      ddbMock.on(PutCommand).resolves({});

      await repository.begin(idemKeyValue, HASH, new Date('2026-01-15T10:00:00.999Z'));

      const [call] = ddbMock.commandCalls(PutCommand);
      expect(call?.args[0].input.Item?.expiresAt).toBe(START_SECONDS + DAY_SECONDS);
    });

    it('reads the existing record with a strongly consistent read after the conflict', async () => {
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({ Item: inProgressItem() });

      await repository.begin(idemKeyValue, HASH, new Date(START));

      const [call] = ddbMock.commandCalls(GetCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { key: idemKeyValue },
        ConsistentRead: true,
      });
    });

    it('returns hash_mismatch when the stored request hash differs', async () => {
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({ Item: inProgressItem({ requestHash: 'hash-b' }) });

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrap()).toEqual({ kind: 'hash_mismatch' });
    });

    it('returns hash_mismatch even when the stored record is COMPLETED', async () => {
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({
        Item: inProgressItem({ requestHash: 'hash-b', state: 'COMPLETED' }),
      });

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrap()).toEqual({ kind: 'hash_mismatch' });
    });

    it('returns completed with the stored status code and body', async () => {
      const body = { id: 'txn-1', status: 'APPROVED' };
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({
        Item: inProgressItem({
          state: 'COMPLETED',
          transactionId: 'txn-1',
          responseStatusCode: 201,
          responseBody: body,
        }),
      });

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrap()).toEqual({ kind: 'completed', statusCode: 201, body });
    });

    it('returns in_progress_fresh when the record is younger than 25 s', async () => {
      clock.advance(24_999);
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({ Item: inProgressItem() });

      const result = await repository.begin(idemKeyValue, HASH, clock.now());

      expect(result._unsafeUnwrap()).toEqual({ kind: 'in_progress_fresh' });
    });

    it('returns in_progress_stale without a transaction id at exactly 25 s', async () => {
      clock.advance(25_000);
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({ Item: inProgressItem() });

      const result = await repository.begin(idemKeyValue, HASH, clock.now());

      expect(result._unsafeUnwrap()).toEqual({
        kind: 'in_progress_stale',
        transactionId: null,
        createdAt: START,
      });
    });

    it('returns in_progress_stale carrying the stored transaction id', async () => {
      clock.advance(60_000);
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({ Item: inProgressItem({ transactionId: 'txn-9' }) });

      const result = await repository.begin(idemKeyValue, HASH, clock.now());

      expect(result._unsafeUnwrap()).toEqual({
        kind: 'in_progress_stale',
        transactionId: 'txn-9',
        createdAt: START,
      });
    });

    it('puts again once when the record vanished between the conflict and the read', async () => {
      ddbMock.on(PutCommand).rejectsOnce(conditionFailed()).resolvesOnce({});
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrap()).toEqual({ kind: 'created' });
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
    });

    it('returns REPOSITORY_ERROR when the record vanishes on both attempts', async () => {
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'RecordVanishedError',
      });
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
    });

    it('maps a non-conditional put failure to REPOSITORY_ERROR without the SDK message', async () => {
      ddbMock.on(PutCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('maps a read failure after the conflict to REPOSITORY_ERROR', async () => {
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingFailure',
      });
    });

    it('maps a malformed stored record to REPOSITORY_ERROR with the class name', async () => {
      ddbMock.on(PutCommand).rejects(conditionFailed());
      ddbMock.on(GetCommand).resolves({ Item: inProgressItem({ state: 'UNKNOWN' }) });

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });

    it('uses UnknownError when the rejected value is not an Error', async () => {
      ddbMock.on(PutCommand).callsFake(() => Promise.reject('plain string'));

      const result = await repository.begin(idemKeyValue, HASH, new Date(START));

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'UnknownError',
      });
    });
  });

  describe('attachTransactionId', () => {
    it('sets the transaction id on an existing record', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await repository.attachTransactionId(idemKeyValue, 'txn-1');

      expect(result.isOk()).toBe(true);
      const [call] = ddbMock.commandCalls(UpdateCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { key: idemKeyValue },
        UpdateExpression: 'SET #transactionId = :transactionId',
        ConditionExpression: 'attribute_exists(#key)',
        ExpressionAttributeNames: { '#key': 'key', '#transactionId': 'transactionId' },
        ExpressionAttributeValues: { ':transactionId': 'txn-1' },
      });
    });

    it('maps a missing record to REPOSITORY_ERROR with the class name', async () => {
      ddbMock.on(UpdateCommand).rejects(conditionFailed());

      const result = await repository.attachTransactionId(idemKeyValue, 'txn-1');

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ConditionalCheckFailedException',
      });
    });

    it('maps an SDK failure to REPOSITORY_ERROR', async () => {
      ddbMock.on(UpdateCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.attachTransactionId(idemKeyValue, 'txn-1');

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingFailure',
      });
    });
  });

  describe('complete', () => {
    it('stores COMPLETED with the response status and body, and nothing else', async () => {
      const body = { id: 'txn-1', status: 'PENDING' };
      ddbMock.on(UpdateCommand).resolves({});

      const result = await repository.complete(idemKeyValue, 201, body);

      expect(result.isOk()).toBe(true);
      const [call] = ddbMock.commandCalls(UpdateCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { key: idemKeyValue },
        UpdateExpression:
          'SET #state = :completed, #responseStatusCode = :statusCode, #responseBody = :body',
        ConditionExpression: 'attribute_exists(#key)',
        ExpressionAttributeNames: {
          '#key': 'key',
          '#state': 'state',
          '#responseStatusCode': 'responseStatusCode',
          '#responseBody': 'responseBody',
        },
        ExpressionAttributeValues: { ':completed': 'COMPLETED', ':statusCode': 201, ':body': body },
      });
    });

    it('maps an SDK failure to REPOSITORY_ERROR', async () => {
      ddbMock.on(UpdateCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.complete(idemKeyValue, 201, {});

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingFailure',
      });
    });
  });

  describe('release', () => {
    it('deletes the record by key', async () => {
      ddbMock.on(DeleteCommand).resolves({});

      const result = await repository.release(idemKeyValue);

      expect(result.isOk()).toBe(true);
      const [call] = ddbMock.commandCalls(DeleteCommand);
      expect(call?.args[0].input).toEqual({ TableName: TABLE, Key: { key: idemKeyValue } });
    });

    it('maps an SDK failure to REPOSITORY_ERROR', async () => {
      ddbMock.on(DeleteCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.release(idemKeyValue);

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingFailure',
      });
    });
  });

  describe('takeOver', () => {
    it('updates conditionally on the previous createdAt and returns taken', async () => {
      clock.advance(40_000);
      ddbMock.on(UpdateCommand).resolves({});

      const result = await repository.takeOver(idemKeyValue, START);

      expect(result._unsafeUnwrap()).toBe('taken');
      const [call] = ddbMock.commandCalls(UpdateCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { key: idemKeyValue },
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
          ':now': '2026-01-15T10:00:40.000Z',
          ':expiresAt': START_SECONDS + 40 + DAY_SECONDS,
          ':inProgress': 'IN_PROGRESS',
          ':previousCreatedAt': START,
        },
      });
    });

    it('returns lost_race when another request changed the record first', async () => {
      ddbMock.on(UpdateCommand).rejects(conditionFailed());

      const result = await repository.takeOver(idemKeyValue, START);

      expect(result._unsafeUnwrap()).toBe('lost_race');
    });

    it('lets only one of two concurrent takers win', async () => {
      ddbMock.on(UpdateCommand).resolvesOnce({}).rejects(conditionFailed());

      const results = await Promise.all([
        repository.takeOver(idemKeyValue, START),
        repository.takeOver(idemKeyValue, START),
      ]);

      expect(results.map((result) => result._unsafeUnwrap()).sort()).toEqual([
        'lost_race',
        'taken',
      ]);
    });

    it('maps an SDK failure to REPOSITORY_ERROR', async () => {
      ddbMock.on(UpdateCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.takeOver(idemKeyValue, START);

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingFailure',
      });
    });
  });
});
