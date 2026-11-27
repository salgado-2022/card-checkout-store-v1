import { createDynamoDocumentClient } from './dynamodb-client';

describe('createDynamoDocumentClient', () => {
  it('takes the region from the Lambda environment', async () => {
    const client = createDynamoDocumentClient({ AWS_REGION: 'us-east-2' });

    expect(await client.config.region()).toBe('us-east-2');
  });

  it('removes undefined attributes before marshalling so they are never written', () => {
    const client = createDynamoDocumentClient({ AWS_REGION: 'us-east-2' });

    expect(client.config.translateConfig?.marshallOptions?.removeUndefinedValues).toBe(true);
  });

  it('builds a client without an explicit region when AWS_REGION is unset', () => {
    expect(() => createDynamoDocumentClient({})).not.toThrow();
  });

  it('defaults to process.env when no environment object is given', async () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = 'us-east-2';
    try {
      const client = createDynamoDocumentClient();

      expect(await client.config.region()).toBe('us-east-2');
    } finally {
      if (previous === undefined) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = previous;
      }
    }
  });
});
