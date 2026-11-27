import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { UpsertCustomerInput } from '../../application/ports/customer-repository';
import { DynamoCustomerRepository } from './customer.repository.dynamodb';

const TABLE = 'test-customers';
const EMAIL = 'ana@example.com';

const INPUT: UpsertCustomerInput = {
  id: 'cust-new',
  email: EMAIL,
  fullName: 'Ana Perez',
  phone: '3001234567',
  documentType: 'CC',
  documentNumber: '1020304050',
  at: '2026-05-01T10:00:00.000Z',
};

const STORED = {
  id: 'cust-1',
  email: EMAIL,
  fullName: 'Ana Old',
  phone: '3000000000',
  documentType: 'CE',
  documentNumber: '123456',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  // Attribute outside the customer field set: must never reach the caller.
  internalNote: 'do not expose',
};

const MAPPED = {
  id: 'cust-1',
  email: EMAIL,
  fullName: 'Ana Old',
  phone: '3000000000',
  documentType: 'CE',
  documentNumber: '123456',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const UPDATED_ATTRIBUTES = {
  ...MAPPED,
  fullName: INPUT.fullName,
  phone: INPUT.phone,
  documentType: INPUT.documentType,
  documentNumber: INPUT.documentNumber,
  updatedAt: INPUT.at,
};

class ThrottlingFailure extends Error {}

describe('DynamoCustomerRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const repository = new DynamoCustomerRepository(client, TABLE);

  afterEach(() => {
    ddbMock.reset();
  });

  describe('findByEmail', () => {
    it('queries the email index with an equality condition and no consistent read', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [STORED] });

      await repository.findByEmail(EMAIL);

      const [call] = ddbMock.commandCalls(QueryCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        IndexName: 'email',
        KeyConditionExpression: '#email = :email',
        ExpressionAttributeNames: { '#email': 'email' },
        ExpressionAttributeValues: { ':email': EMAIL },
        Limit: 1,
      });
    });

    it('maps the matching item to the exact customer field set', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [STORED] });

      const result = await repository.findByEmail(EMAIL);

      expect(result._unsafeUnwrap()).toEqual(MAPPED);
    });

    it('returns Ok(null) when the index has no item for the email', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await repository.findByEmail('nobody@example.com');

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('treats a response without Items as no match', async () => {
      ddbMock.on(QueryCommand).resolves({});

      const result = await repository.findByEmail(EMAIL);

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns REPOSITORY_ERROR with the class name when the stored item is malformed', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ ...STORED, documentType: 'PASSPORT' }] });

      const result = await repository.findByEmail(EMAIL);

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });

    it('maps an SDK failure to REPOSITORY_ERROR with the class name only', async () => {
      ddbMock.on(QueryCommand).rejects(new ThrottlingFailure('internal detail'));

      const result = await repository.findByEmail(EMAIL);

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('uses UnknownError when the rejected value is not an Error', async () => {
      ddbMock.on(QueryCommand).callsFake(() => Promise.reject('plain string'));

      const result = await repository.findByEmail(EMAIL);

      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'UnknownError',
      });
    });
  });

  describe('findById', () => {
    it('reads the item with a strongly consistent get and maps it', async () => {
      ddbMock.on(GetCommand).resolves({ Item: STORED });

      const result = await repository.findById('cust-1');

      expect(result._unsafeUnwrap()).toEqual(MAPPED);
      const [call] = ddbMock.commandCalls(GetCommand);
      expect(call?.args[0].input).toEqual({
        TableName: TABLE,
        Key: { id: 'cust-1' },
        ConsistentRead: true,
      });
    });

    it('returns Ok(null) when the item does not exist', async () => {
      ddbMock.on(GetCommand).resolves({});

      const result = await repository.findById('cust-missing');

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

      const result = await repository.findById('cust-1');

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('internal detail');
    });

    it('returns REPOSITORY_ERROR when the stored item is malformed', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...STORED, id: '' } });

      const result = await repository.findById('cust-1');

      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
    });
  });

  describe('upsert', () => {
    describe('when no customer has the email (create path)', () => {
      beforeEach(() => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        ddbMock.on(PutCommand).resolves({});
      });

      it('inserts the item with the generated id and equal createdAt and updatedAt', async () => {
        await repository.upsert(INPUT);

        const [call] = ddbMock.commandCalls(PutCommand);
        expect(call?.args[0].input).toEqual({
          TableName: TABLE,
          Item: {
            id: 'cust-new',
            email: EMAIL,
            fullName: 'Ana Perez',
            phone: '3001234567',
            documentType: 'CC',
            documentNumber: '1020304050',
            createdAt: INPUT.at,
            updatedAt: INPUT.at,
          },
          ConditionExpression: 'attribute_not_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id' },
        });
        expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      });

      it('returns the created customer and created = true', async () => {
        const result = await repository.upsert(INPUT);

        expect(result._unsafeUnwrap()).toEqual({
          created: true,
          customer: {
            id: 'cust-new',
            email: EMAIL,
            fullName: 'Ana Perez',
            phone: '3001234567',
            documentType: 'CC',
            documentNumber: '1020304050',
            createdAt: INPUT.at,
            updatedAt: INPUT.at,
          },
        });
      });

      it('returns REPOSITORY_ERROR with the class name when the conditional put is rejected', async () => {
        class ConditionalCheckFailed extends Error {}
        ddbMock.on(PutCommand).rejects(new ConditionalCheckFailed('item exists'));

        const result = await repository.upsert(INPUT);

        expect(result._unsafeUnwrapErr()).toEqual({
          kind: 'REPOSITORY_ERROR',
          reason: 'ConditionalCheckFailed',
        });
      });
    });

    describe('when a customer already has the email (update path)', () => {
      beforeEach(() => {
        ddbMock.on(QueryCommand).resolves({ Items: [STORED] });
        ddbMock.on(UpdateCommand).resolves({ Attributes: UPDATED_ATTRIBUTES });
      });

      it('updates the stored item by its existing id, not by the generated one', async () => {
        await repository.upsert(INPUT);

        const [call] = ddbMock.commandCalls(UpdateCommand);
        expect(call?.args[0].input).toMatchObject({
          TableName: TABLE,
          Key: { id: 'cust-1' },
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id' },
          ReturnValues: 'ALL_NEW',
        });
      });

      it('sets only the mutable fields and never writes createdAt, email or id', async () => {
        await repository.upsert(INPUT);

        const [call] = ddbMock.commandCalls(UpdateCommand);
        const input = call?.args[0].input;
        expect(input?.UpdateExpression).toBe(
          'SET #fullName = :fullName, #phone = :phone, #documentType = :documentType, #documentNumber = :documentNumber, #updatedAt = :updatedAt',
        );
        expect(input?.ExpressionAttributeValues).toEqual({
          ':fullName': 'Ana Perez',
          ':phone': '3001234567',
          ':documentType': 'CC',
          ':documentNumber': '1020304050',
          ':updatedAt': INPUT.at,
        });
        expect(input?.UpdateExpression).not.toContain('createdAt');
        expect(input?.UpdateExpression).not.toContain('#email');
      });

      it('does not insert a new item', async () => {
        await repository.upsert(INPUT);

        expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      });

      it('returns the updated customer from the stored attributes and created = false', async () => {
        const result = await repository.upsert(INPUT);

        expect(result._unsafeUnwrap()).toEqual({
          created: false,
          customer: {
            id: 'cust-1',
            email: EMAIL,
            fullName: 'Ana Perez',
            phone: '3001234567',
            documentType: 'CC',
            documentNumber: '1020304050',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: INPUT.at,
          },
        });
      });

      it('returns REPOSITORY_ERROR when the update returns no attributes', async () => {
        ddbMock.on(UpdateCommand).resolves({});

        const result = await repository.upsert(INPUT);

        expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ZodError' });
      });

      it('returns REPOSITORY_ERROR when the update is rejected', async () => {
        ddbMock.on(UpdateCommand).rejects(new ThrottlingFailure('internal detail'));

        const result = await repository.upsert(INPUT);

        const error = result._unsafeUnwrapErr();
        expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
        expect(JSON.stringify(error)).not.toContain('internal detail');
      });
    });

    it('returns REPOSITORY_ERROR and writes nothing when the email lookup fails', async () => {
      ddbMock.on(QueryCommand).rejects(new ThrottlingFailure('lookup detail'));

      const result = await repository.upsert(INPUT);

      const error = result._unsafeUnwrapErr();
      expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'ThrottlingFailure' });
      expect(JSON.stringify(error)).not.toContain('lookup detail');
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });
});
