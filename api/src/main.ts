import { prepareApp } from './infrastructure/bootstrap/bootstrap';
import { loadConfig } from './infrastructure/config/env.config';
import { createOriginSecretProvider } from './infrastructure/config/origin-secret.provider';
import { createApp } from './infrastructure/http/create-app';

const DEFAULT_PORT = 3000;

async function main(): Promise<void> {
  const prepared = await prepareApp({
    loadConfig,
    createSecretProvider: createOriginSecretProvider,
    createApp,
  });
  if (prepared.isErr()) {
    process.stderr.write(`Startup failed: ${prepared.error.message}\n`);
    process.exit(1);
  }
  await prepared.value.listen(Number(process.env.PORT) || DEFAULT_PORT);
}

void main();
