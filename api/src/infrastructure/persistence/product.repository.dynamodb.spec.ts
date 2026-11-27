import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoProductRepository } from './product.repository.dynamodb';

const TABLE = 'test-products';

const ITEM = {
  id: 'prod-1',
  sku: 'SKU-1',
  name: 'Lamp',
  description: 'Desk lamp',
  imageUrl: '/images/lamp.webp',
  priceInCents: 12_000_000,
  currency: 'COP',
  stock: 4,
  // Attribute outside the catalog field set: must never reach the caller.
  internalNote: 'do not expose',
};

const MAPPED = {
  id: 'prod-1',
  sku: 'SKU-1',
  name: 'Lamp',
  description: 'Desk lamp',
  imageUrl: '/images/lamp.webp',
  priceInCents: 12_000_000,
  currency: 'COP',
  stock: 4,
};

class ThrottlingFailure extends Error {}

describe('DynamoProductRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const repository = new DynamoProductRepository(client, TABLE);

  afterEach(() => {
    ddbMock.reset();
  });

  describe('findAll', () => {
    it('reads the whole table with a strongly consistent scan', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [ITEM] });

      await repository.findAll();

      const [call] = ddbMock.commandCalls(ScanCommand);
      expect(call?.args[0].input).toMatchObject({ TableName: TABLE, ConsistentRead: true });
    });

    it('follows LastEvaluatedKey until every page is read', async () => {
      const cursor = { id: 'prod-1' };
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [ITEM], LastEvaluatedKey: cursor })
        .resolvesOnce({ Items: [{ ...ITEM, id: 'prod-2', sku: 'SKU-2' }] });

      const result = await repository.findAll();

      const products = result._unsafeUnwrap();
      expect(products.map((product) => product.id)).toEqual(['prod-1', 'prod-2']);
      const calls = ddbMock.commandCalls(ScanCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual(cursor);
    });

    it('maps every item to the exact field set and keeps stock 0', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [{ ...ITEM, stock: 0 }] });

      const result = await repository.findAll();

      expect(result._unsafeUnwrap()).toEqual([{ ...MAPPED, stock: 0 }]);
    });

    it('treats a page without Items as empty', async () => {
      ddbMock.on(ScanCommand).resolves({});

      const result = await repository.findAll();

      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns an empty list for an empty table', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const result = await repository.findAll();

      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns REPOSITORY_ERROR with the class name and no message when the item is malformed', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [{ ...ITEM, priceInCents: 1.5 }] });

      const result = await repository.findAll();

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });

    it('maps an SDK failure to REPOSITORY_ERROR with the class name only', async () => {
      ddbMock
        .on(ScanCommand)
        .callsFake(() => Promise.reject(new ThrottlingFailure('secret sdk text')));

      const result = await repository.findAll();

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('secret sdk text');
    });

    it('uses UnknownError when the rejected value is not an Error', async () => {
      ddbMock.on(ScanCommand).callsFake(() => Promise.reject('plain string'));

      const result = await repository.findAll();

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'UnknownError',
      });
    });

    it('fails with REPOSITORY_ERROR when a later page fails', async () => {
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [ITEM], LastEvaluatedKey: { id: 'prod-1' } })
        .rejectsOnce(new ThrottlingFailure('later page'));

      const result = await repository.findAll();

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingFailure',
      });
    });
  });

  describe('findById', () => {
    it('reads the item with a strongly consistent get and maps it', async () => {
      ddbMock.on(GetCommand).resolves({ Item: ITEM });

      const result = await repository.findById('prod-1');

      expect(result._unsafeUnwrap()).toEqual(MAPPED);
      const [call] = ddbMock.commandCalls(GetCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { id: 'prod-1' },
        ConsistentRead: true,
      });
    });

    it('returns Ok(null) when the item does not exist', async () => {
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.findById('prod-missing');

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it.each([
      ['an empty id', ''],
      ['an id above the 2048-byte key limit', 'x'.repeat(2049)],
    ])('returns Ok(null) without calling DynamoDB for %s', async (_label, id) => {
      const result = await repository.findById(id);

      expect(result._unsafeUnwrap()).toBeNull();
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('accepts an id of exactly 2048 bytes', async () => {
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.findById('x'.repeat(2048));

      expect(result._unsafeUnwrap()).toBeNull();
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    });

    it('maps an SDK failure to REPOSITORY_ERROR with the class name only', async () => {
      ddbMock.on(GetCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.findById('prod-1');

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('returns REPOSITORY_ERROR when the stored item is malformed', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...ITEM, stock: -1 } });

      const result = await repository.findById('prod-1');

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });
  });
});
