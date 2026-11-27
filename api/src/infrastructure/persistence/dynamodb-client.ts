import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Lambda always sets AWS_REGION. An unset region fails on the first SDK call, not here,
// so building the module graph never performs I/O or throws on its own.
export function createDynamoDocumentClient(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): DynamoDBDocumentClient {
  const client = new DynamoDBClient({ region: env.AWS_REGION });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
