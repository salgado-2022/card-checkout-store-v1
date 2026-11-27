import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { FinalizeInput, NewTransaction } from '../../application/ports/transaction-repository';
import type { Transaction } from '../../domain/entities';
import { DynamoTransactionRepository } from './transaction.repository.dynamodb';

const TABLE = 'test-transactions';
const DELIVERIES_TABLE = 'test-deliveries';
const PRODUCTS_TABLE = 'test-products';

const INPUT: NewTransaction = {
  id: 'txn-1',
  reference: 'ORD-01TESTREFERENCE0000000000',
  productId: 'prod-1',
  quantity: 2,
  customerId: 'cust-1',
  deliveryId: 'del-1',
  unitPriceInCents: 12_000_000,
  subtotalInCents: 24_000_000,
  baseFeeInCents: 300_000,
  deliveryFeeInCents: 800_000,
  totalInCents: 25_100_000,
  currency: 'COP',
  installments: 3,
  cardBrand: 'VISA',
  cardLastFour: '4242',
  createdAt: '2026-05-01T10:00:00.000Z',
};

const PENDING_ITEM: Transaction = {
  id: 'txn-1',
  reference: 'ORD-01TESTREFERENCE0000000000',
  status: 'PENDING',
  productId: 'prod-1',
  quantity: 2,
  customerId: 'cust-1',
  deliveryId: 'del-1',
  unitPriceInCents: 12_000_000,
  subtotalInCents: 24_000_000,
  baseFeeInCents: 300_000,
  deliveryFeeInCents: 800_000,
  totalInCents: 25_100_000,
  currency: 'COP',
  installments: 3,
  cardBrand: 'VISA',
  cardLastFour: '4242',
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:00:00.000Z',
};

// Card data that must never reach DynamoDB, even when a caller passes it by mistake.
const CARD_DATA_FIELDS = {
  cardToken: 'tok_test_fake',
  cardNumber: '4242424242424242',
  cvc: '123',
  expiry: '12/30',
};

// Lower-case fragments of attribute names that would reveal card data.
const FORBIDDEN_KEY_FRAGMENTS = ['token', 'cardnumber', 'cvc', 'cvv', 'expir'];

const STORED_ITEM_KEYS = [
  'id',
  'reference',
  'status',
  'productId',
  'quantity',
  'customerId',
  'deliveryId',
  'unitPriceInCents',
  'subtotalInCents',
  'baseFeeInCents',
  'deliveryFeeInCents',
  'totalInCents',
  'currency',
  'installments',
  'cardBrand',
  'cardLastFour',
  'createdAt',
  'updatedAt',
];

class ThrottlingFailure extends Error {}

describe('DynamoTransactionRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const repository = new DynamoTransactionRepository(client, TABLE, {
    deliveries: DELIVERIES_TABLE,
    products: PRODUCTS_TABLE,
  });

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

    it('returns the created transaction', async () => {
      const result = await repository.create(INPUT);

      expect(result._unsafeUnwrap()).toEqual(PENDING_ITEM);
    });

    it('stores exactly the transaction field set and no optional state', async () => {
      await repository.create(INPUT);

      const [call] = ddbMock.commandCalls(PutCommand);
      const item = call?.args[0].input.Item ?? {};
      expect(Object.keys(item).sort()).toEqual([...STORED_ITEM_KEYS].sort());
      expect(item).not.toHaveProperty('statusReason');
      expect(item).not.toHaveProperty('externalId');
      expect(item).not.toHaveProperty('lastSyncedAt');
      expect(item).not.toHaveProperty('finalizedAt');
    });

    it('never stores a card token, card number, CVC or expiry', async () => {
      const withCardData = { ...INPUT, ...CARD_DATA_FIELDS };

      await repository.create(withCardData);

      const [call] = ddbMock.commandCalls(PutCommand);
      const keys = Object.keys(call?.args[0].input.Item ?? {}).map((key) => key.toLowerCase());
      for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
        expect(keys.filter((key) => key.includes(fragment))).toEqual([]);
      }
      const stored = JSON.stringify(call?.args[0].input.Item);
      for (const value of Object.values(CARD_DATA_FIELDS)) {
        expect(stored).not.toContain(value);
      }
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
    it('reads the item with a strongly consistent get and maps it to the transaction', async () => {
      ddbMock.on(GetCommand).resolves({ Item: PENDING_ITEM });

      const result = await repository.findById('txn-1');

      expect(result._unsafeUnwrap()).toEqual(PENDING_ITEM);
      const [call] = ddbMock.commandCalls(GetCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { id: 'txn-1' },
        ConsistentRead: true,
      });
    });

    it('drops card data that a legacy item might carry', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...PENDING_ITEM, ...CARD_DATA_FIELDS } });

      const result = await repository.findById('txn-1');

      const transaction = result._unsafeUnwrap() ?? {};
      expect(transaction).toEqual(PENDING_ITEM);
      expect(JSON.stringify(transaction)).not.toContain(CARD_DATA_FIELDS.cardNumber);
      expect(JSON.stringify(transaction)).not.toContain(CARD_DATA_FIELDS.cardToken);
    });

    it('returns Ok(null) when the item does not exist', async () => {
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.findById('txn-missing');

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

      const result = await repository.findById('txn-1');

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('returns REPOSITORY_ERROR when the stored item is malformed', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...PENDING_ITEM, status: 'SHIPPED' } });

      const result = await repository.findById('txn-1');

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });
  });

  describe('findByReference', () => {
    it('queries the reference index with an equality condition, no consistent read', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [PENDING_ITEM] });

      const result = await repository.findByReference(PENDING_ITEM.reference);

      expect(result._unsafeUnwrap()).toEqual(PENDING_ITEM);
      const [call] = ddbMock.commandCalls(QueryCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        IndexName: 'reference',
        KeyConditionExpression: '#reference = :reference',
        ExpressionAttributeNames: { '#reference': 'reference' },
        ExpressionAttributeValues: { ':reference': PENDING_ITEM.reference },
        Limit: 1,
      });
    });

    it('returns Ok(null) when the index has no item for the reference', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await repository.findByReference('ORD-unknown');

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('treats a response without Items as no match', async () => {
      ddbMock.on(QueryCommand).resolves({});

      const result = await repository.findByReference('ORD-unknown');

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns Ok(null) without calling DynamoDB for an empty reference', async () => {
      const result = await repository.findByReference('');

      expect(result._unsafeUnwrap()).toBeNull();
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it('returns REPOSITORY_ERROR with the class name only when the query is rejected', async () => {
      ddbMock.on(QueryCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.findByReference(PENDING_ITEM.reference);

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('returns REPOSITORY_ERROR when the matched item is malformed', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ ...PENDING_ITEM, cardBrand: 'AMEX' }] });

      const result = await repository.findByReference(PENDING_ITEM.reference);

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });
  });

  describe('setExternalId', () => {
    it('sets externalId only when the transaction exists', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await repository.setExternalId('txn-1', 'ext-1');

      expect(result._unsafeUnwrap()).toBeUndefined();
      const [call] = ddbMock.commandCalls(UpdateCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { id: 'txn-1' },
        UpdateExpression: 'SET #externalId = :externalId',
        ConditionExpression: 'attribute_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id', '#externalId': 'externalId' },
        ExpressionAttributeValues: { ':externalId': 'ext-1' },
      });
    });

    it('returns REPOSITORY_ERROR with the class name only when the update is rejected', async () => {
      ddbMock.on(UpdateCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.setExternalId('txn-1', 'ext-1');

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });
  });

  describe('setLastSynced', () => {
    it('stores the instant as an ISO-8601 string when the transaction exists', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await repository.setLastSynced('txn-1', new Date('2026-05-01T10:00:02.000Z'));

      expect(result._unsafeUnwrap()).toBeUndefined();
      const [call] = ddbMock.commandCalls(UpdateCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { id: 'txn-1' },
        UpdateExpression: 'SET #lastSyncedAt = :lastSyncedAt',
        ConditionExpression: 'attribute_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id', '#lastSyncedAt': 'lastSyncedAt' },
        ExpressionAttributeValues: { ':lastSyncedAt': '2026-05-01T10:00:02.000Z' },
      });
    });

    it('returns REPOSITORY_ERROR with the class name only when the update is rejected', async () => {
      ddbMock.on(UpdateCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.setLastSynced('txn-1', new Date());

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('returns REPOSITORY_ERROR without writing when the date is invalid', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await repository.setLastSynced('txn-1', new Date('not-a-date'));

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'RangeError',
      });
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe('finalize', () => {
    const AT = '2026-05-01T10:05:00.000Z';
    const APPROVE: FinalizeInput = {
      transactionId: 'txn-1',
      deliveryId: 'del-1',
      productId: 'prod-1',
      quantity: 2,
      status: 'APPROVED',
      deliveryStatus: 'ASSIGNED',
      at: AT,
    };
    const DECLINE: FinalizeInput = {
      ...APPROVE,
      status: 'DECLINED',
      statusReason: 'DECLINED',
      deliveryStatus: 'CANCELLED',
    };
    const FINAL_ITEM: Transaction = {
      ...PENDING_ITEM,
      status: 'DECLINED',
      statusReason: 'DECLINED',
      finalizedAt: '2026-05-01T10:04:00.000Z',
      updatedAt: '2026-05-01T10:04:00.000Z',
    };
    const reasons = (...codes: string[]) =>
      new TransactionCanceledException({
        message: 'secret sdk message',
        $metadata: {},
        CancellationReasons: codes.map((Code) => ({ Code })),
      });
    const writeItems = () => {
      const [call] = ddbMock.commandCalls(TransactWriteCommand);
      return call?.args[0].input.TransactItems ?? [];
    };
    beforeEach(() => {
      ddbMock.on(GetCommand).resolves({ Item: PENDING_ITEM });
      ddbMock.on(TransactWriteCommand).resolves({});
    });
    it('approves with one TransactWriteItems: transaction, delivery and conditional stock decrement', async () => {
      const result = await repository.finalize(APPROVE);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
      expect(writeItems()).toEqual([
        {
          Update: {
            TableName: TABLE,
            Key: { id: 'txn-1' },
            UpdateExpression: 'SET #status = :status, #finalizedAt = :at, #updatedAt = :at',
            ConditionExpression: '#status = :pending',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#finalizedAt': 'finalizedAt',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: { ':status': 'APPROVED', ':pending': 'PENDING', ':at': AT },
          },
        },
        {
          Update: {
            TableName: DELIVERIES_TABLE,
            Key: { id: 'del-1' },
            UpdateExpression: 'SET #status = :status, #updatedAt = :at',
            ConditionExpression: '#status = :pending',
            ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':status': 'ASSIGNED', ':pending': 'PENDING', ':at': AT },
          },
        },
        {
          Update: {
            TableName: PRODUCTS_TABLE,
            Key: { id: 'prod-1' },
            UpdateExpression: 'SET #stock = #stock - :quantity',
            ConditionExpression: '#stock >= :quantity',
            ExpressionAttributeNames: { '#stock': 'stock' },
            ExpressionAttributeValues: { ':quantity': 2 },
          },
        },
      ]);
      expect(result._unsafeUnwrap()).toEqual({
        kind: 'applied',
        transaction: { ...PENDING_ITEM, status: 'APPROVED', finalizedAt: AT, updatedAt: AT },
      });
    });
    it('declined family: stores the reason, cancels the delivery and never touches the product', async () => {
      const result = await repository.finalize(DECLINE);
      const items = writeItems();
      expect(items).toHaveLength(2);
      expect(items[0]?.Update?.UpdateExpression).toContain('#statusReason = :reason');
      expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({
        ':status': 'DECLINED',
        ':reason': 'DECLINED',
      });
      expect(items[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ':status': 'CANCELLED' });
      expect(JSON.stringify(items)).not.toContain(PRODUCTS_TABLE);
      expect(result._unsafeUnwrap()).toMatchObject({
        kind: 'applied',
        transaction: { status: 'DECLINED', statusReason: 'DECLINED', finalizedAt: AT },
      });
    });
    it('BACKORDER: approves the transaction and the delivery without a product write', async () => {
      const result = await repository.finalize({ ...APPROVE, deliveryStatus: 'BACKORDER' });
      const items = writeItems();
      expect(items).toHaveLength(2);
      expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ':status': 'APPROVED' });
      expect(items[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ':status': 'BACKORDER' });
      expect(result._unsafeUnwrap().kind).toBe('applied');
    });
    it('omits statusReason from the item when none is given', async () => {
      await repository.finalize(APPROVE);
      expect(writeItems()[0]?.Update?.UpdateExpression).not.toContain('statusReason');
    });
    it('returns already_final without writing when the stored transaction is not PENDING', async () => {
      ddbMock.on(GetCommand).resolves({ Item: FINAL_ITEM });
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrap()).toEqual({ kind: 'already_final', transaction: FINAL_ITEM });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
    it('returns stock_unavailable when only the product condition failed', async () => {
      ddbMock.on(TransactWriteCommand).rejects(reasons('None', 'None', 'ConditionalCheckFailed'));
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrap()).toEqual({ kind: 'stock_unavailable' });
    });
    it('re-reads and returns the stored state when the transaction condition failed', async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: PENDING_ITEM })
        .resolvesOnce({ Item: FINAL_ITEM });
      ddbMock
        .on(TransactWriteCommand)
        .rejects(reasons('ConditionalCheckFailed', 'None', 'ConditionalCheckFailed'));
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrap()).toEqual({ kind: 'already_final', transaction: FINAL_ITEM });
      expect(ddbMock.commandCalls(GetCommand).every((c) => c.args[0].input.ConsistentRead)).toBe(
        true,
      );
    });
    it.each([
      ['the delivery condition failed', ['None', 'ConditionalCheckFailed', 'None']],
      [
        'delivery and product both failed',
        ['None', 'ConditionalCheckFailed', 'ConditionalCheckFailed'],
      ],
      ['another reason is reported', ['None', 'None', 'TransactionConflict']],
      ['no reasons are reported', []],
    ])('returns REPOSITORY_ERROR when %s', async (_name, codes) => {
      ddbMock.on(TransactWriteCommand).rejects(reasons(...codes));
      const error = (await repository.finalize(APPROVE))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'TransactionCanceledException' });
      expect(JSON.stringify(error)).not.toContain('secret sdk message');
    });
    it('ignores a product failure for a declined finalization', async () => {
      ddbMock.on(TransactWriteCommand).rejects(reasons('None', 'None', 'ConditionalCheckFailed'));
      const result = await repository.finalize(DECLINE);
      expect(result._unsafeUnwrapErr().reason).toBe('TransactionCanceledException');
    });
    it('returns REPOSITORY_ERROR when the transaction condition failed but it is still PENDING', async () => {
      ddbMock.on(TransactWriteCommand).rejects(reasons('ConditionalCheckFailed'));
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'FinalizationConflictError',
      });
    });
    it('returns REPOSITORY_ERROR when the transaction disappears after a failed condition', async () => {
      ddbMock.on(GetCommand).resolvesOnce({ Item: PENDING_ITEM }).resolvesOnce({});
      ddbMock.on(TransactWriteCommand).rejects(reasons('ConditionalCheckFailed'));
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrapErr().reason).toBe('FinalizationConflictError');
    });
    it('returns REPOSITORY_ERROR for an unknown transaction without writing', async () => {
      ddbMock.on(GetCommand).resolves({});
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'TransactionNotFoundError',
      });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
    it('returns REPOSITORY_ERROR with the class name only when the SDK fails', async () => {
      ddbMock.on(TransactWriteCommand).rejects(new ThrottlingFailure('secret sdk message'));
      const error = (await repository.finalize(APPROVE))._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
    });
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects quantity %s without reading or writing',
      async (quantity) => {
        const result = await repository.finalize({ ...APPROVE, quantity });
        expect(result._unsafeUnwrapErr()).toEqual({
          kind: 'REPOSITORY_ERROR',
          reason: 'InvalidFinalizationQuantity',
        });
        expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      },
    );
    it.each(['DECLINED', 'VOIDED', 'ERROR'] as const)(
      'rejects an ASSIGNED delivery with status %s without reading or writing',
      async (status) => {
        const result = await repository.finalize({ ...APPROVE, status });
        expect(result._unsafeUnwrapErr()).toEqual({
          kind: 'REPOSITORY_ERROR',
          reason: 'InvalidFinalizationStatus',
        });
        expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      },
    );
    it('still accepts an approved BACKORDER delivery and a quantity of 1', async () => {
      const result = await repository.finalize({
        ...APPROVE,
        quantity: 1,
        deliveryStatus: 'BACKORDER',
      });
      expect(result._unsafeUnwrap().kind).toBe('applied');
    });
    it('returns REPOSITORY_ERROR when the initial read fails', async () => {
      ddbMock.on(GetCommand).rejects(new ThrottlingFailure('boom'));
      const result = await repository.finalize(APPROVE);
      expect(result._unsafeUnwrapErr().reason).toBe('ThrottlingFailure');
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
  });
});
