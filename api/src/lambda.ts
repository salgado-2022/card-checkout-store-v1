import {
  adaptNestApp,
  createInitCache,
  initServer,
  type LambdaHandler,
} from './infrastructure/bootstrap/bootstrap';
import { loadConfig } from './infrastructure/config/env.config';
import { createOriginSecretProvider } from './infrastructure/config/origin-secret.provider';
import { createApp } from './infrastructure/http/create-app';

const getServer = createInitCache(() =>
  initServer({
    loadConfig,
    createSecretProvider: createOriginSecretProvider,
    createApp,
    adapt: adaptNestApp,
  }),
);

// The only `throw` of the API: the Lambda runtime needs a rejected promise to report a failed start.
export const handler: LambdaHandler = async (event, context) => {
  const server = await getServer();
  if (server.isErr()) {
    throw new Error(server.error.message);
  }
  return server.value(event, context);
};
