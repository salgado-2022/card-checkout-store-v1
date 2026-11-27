import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import {
  createTransactionsHttpApp,
  type TransactionsHttpApp,
} from '../../../../test/support/transactions-http-app';

const DOCUMENTED_STATUSES = ['201', '200', '400', '404', '409', '415', '422', '429', '502'];

describe('POST /api/v1/transactions (OpenAPI)', () => {
  let testApp: TransactionsHttpApp;
  let document: OpenAPIObject;

  beforeAll(async () => {
    testApp = await createTransactionsHttpApp();
    document = SwaggerModule.createDocument(testApp.app, new DocumentBuilder().build());
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it('documents the Idempotency-Key header as required', () => {
    const operation = document.paths['/api/v1/transactions']?.post;

    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
  });

  it('documents every status code the endpoint can answer', () => {
    const operation = document.paths['/api/v1/transactions']?.post;

    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([...DOCUMENTED_STATUSES].sort());
  });

  it('documents the transaction response shape on 201 and 200', () => {
    const operation = document.paths['/api/v1/transactions']?.post;

    expect(operation?.responses['201']).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/TransactionResponseDto' } },
      },
    });
    expect(operation?.responses['200']).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/TransactionResponseDto' } },
      },
    });
  });
});
