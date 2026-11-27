import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { NewDelivery } from '../../application/ports/delivery-repository';
import { DynamoDeliveryRepository } from './delivery.repository.dynamodb';

const TABLE = 'test-deliveries';

const INPUT: NewDelivery = {
  id: 'del-1',
  transactionId: 'txn-1',
  productId: 'prod-1',
  quantity: 2,
  recipientName: 'Ana Perez',
  phone: '3001234567',
  addressLine1: 'Calle 1 # 2-3',
  addressLine2: 'Apto 401',
  city: 'Bogotá',
  department: 'Bogotá D.C.',
  postalCode: '110111',
  createdAt: '2026-05-01T10:00:00.000Z',
};

const PENDING_ITEM = {
  id: 'del-1',
  transactionId: 'txn-1',
  productId: 'prod-1',
  quantity: 2,
  recipientName: 'Ana Perez',
  phone: '3001234567',
  addressLine1: 'Calle 1 # 2-3',
  addressLine2: 'Apto 401',
  city: 'Bogotá',
  department: 'Bogotá D.C.',
  postalCode: '110111',
  status: 'PENDING',
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:00:00.000Z',
};

class ThrottlingFailure extends Error {}

describe('DynamoDeliveryRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const repository = new DynamoDeliveryRepository(client, TABLE);

  afterEach(() => {
    ddbMock.reset();
  });

  describe('create', () => {
    beforeEach(() => {
      ddbMock.on(PutCommand).resolves({});
    });

    it('writes a conditional put on the id with status PENDING and updatedAt equal to createdAt', async () => {
      await repository.create(INPUT);

      const [call] = ddbMock.commandCalls(PutCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Item: PENDING_ITEM,
        ConditionExpression: 'attribute_not_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id' },
      });
    });

    it('returns the created delivery', async () => {
      const result = await repository.create(INPUT);

      expect(result._unsafeUnwrap()).toEqual(PENDING_ITEM);
    });

    it('omits the optional fields when the input does not have them', async () => {
      const required: NewDelivery = {
        id: INPUT.id,
        transactionId: INPUT.transactionId,
        productId: INPUT.productId,
        quantity: INPUT.quantity,
        recipientName: INPUT.recipientName,
        phone: INPUT.phone,
        addressLine1: INPUT.addressLine1,
        city: INPUT.city,
        department: INPUT.department,
        createdAt: INPUT.createdAt,
      };

      const result = await repository.create(required);

      const [call] = ddbMock.commandCalls(PutCommand);
      const item = call?.args[0].input.Item ?? {};
      expect(item).not.toHaveProperty('addressLine2');
      expect(item).not.toHaveProperty('postalCode');
      expect(result._unsafeUnwrap()).not.toHaveProperty('addressLine2');
      expect(result._unsafeUnwrap()).not.toHaveProperty('postalCode');
    });

    it('does not persist attributes outside the delivery field set', async () => {
      const withExtra = { ...INPUT, cardToken: 'tok_test_fake' };

      await repository.create(withExtra);

      const [call] = ddbMock.commandCalls(PutCommand);
      expect(call?.args[0].input.Item).not.toHaveProperty('cardToken');
    });

    it('returns REPOSITORY_ERROR with the class name only when the put is rejected', async () => {
      ddbMock.on(PutCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.create(INPUT);

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('uses UnknownError when the rejected value is not an Error', async () => {
      ddbMock.on(PutCommand).callsFake(() => Promise.reject('plain string'));

      const result = await repository.create(INPUT);

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'UnknownError',
      });
    });
  });

  describe('findById', () => {
    it('reads the item with a strongly consistent get and maps it to the delivery', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...PENDING_ITEM, internalNote: 'hidden' } });

      const result = await repository.findById('del-1');

      expect(result._unsafeUnwrap()).toEqual(PENDING_ITEM);
      const [call] = ddbMock.commandCalls(GetCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { id: 'del-1' },
        ConsistentRead: true,
      });
    });

    it('returns Ok(null) when the item does not exist', async () => {
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.findById('del-missing');

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

    it('returns REPOSITORY_ERROR with the class name only when the get is rejected', async () => {
      ddbMock.on(GetCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.findById('del-1');

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('returns REPOSITORY_ERROR when the stored item is malformed', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...PENDING_ITEM, status: 'SHIPPED' } });

      const result = await repository.findById('del-1');

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });
  });
});
