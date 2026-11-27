import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { ok, okAsync } from 'neverthrow';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from '../src/infrastructure/config/env.config';
import type { OriginSecretSource } from '../src/infrastructure/config/origin-secret.provider';
import {
  AppModule,
  DYNAMODB_DOCUMENT_CLIENT,
  PAYMENT_GATEWAY,
} from '../src/infrastructure/http/app.module';
import { GLOBAL_PREFIX } from '../src/infrastructure/http/create-app';
import { ERROR_CATALOG, type ErrorCode } from '../src/infrastructure/http/error-catalog';
import { JsonLogger } from '../src/infrastructure/http/logging/json-logger';
import type { PaymentGatewayAdapter } from '../src/infrastructure/payment/payment-gateway.adapter';

// Generates docs/openapi.json from the real controllers. Nothing here opens a port, reads SSM,
// calls AWS or calls the payment provider: the module graph gets stubs for every external client.
export const OPENAPI_OUTPUT_PATH = resolve(__dirname, '..', '..', 'docs', 'openapi.json');
export const PLACEHOLDER_ORIGIN_VERIFY_VALUE = 'openapi-generator-placeholder';

const ERROR_ENVELOPE_DTO_SCHEMA = 'ErrorEnvelopeDto';
const ERROR_ENVELOPE_SCHEMA = 'ErrorEnvelope';
const ERROR_ENVELOPE_DTO_REF = `#/components/schemas/${ERROR_ENVELOPE_DTO_SCHEMA}`;
const ERROR_ENVELOPE_REF = `#/components/schemas/${ERROR_ENVELOPE_SCHEMA}`;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const generatorConfig: AppConfig = {
  paymentApiUrl: 'https://payment.example.invalid',
  paymentPublicKey: 'pub_generator_placeholder',
  paymentPrivateKeyParam: 'generator-unused-param',
  paymentIntegritySecretParam: 'generator-unused-param',
  paymentEventsSecretParam: 'generator-unused-param',
  originVerifySecretParam: 'generator-unused-param',
  baseFeeInCents: 300_000,
  deliveryFeeInCents: 800_000,
  tables: {
    products: 'generator-products',
    customers: 'generator-customers',
    transactions: 'generator-transactions',
    deliveries: 'generator-deliveries',
    idempotencyKeys: 'generator-idempotency-keys',
  },
};

const placeholderOriginSecret: OriginSecretSource = {
  load: () => okAsync(PLACEHOLDER_ORIGIN_VERIFY_VALUE),
  get: () => ok(PLACEHOLDER_ORIGIN_VERIFY_VALUE),
};

// Never called while generating: the document is built from metadata only. A missing method would
// fail loudly with a TypeError, so an accidental call cannot reach AWS or the provider.
const unusedDocumentClient = {} as DynamoDBDocumentClient;
const unusedPaymentGateway = {} as PaymentGatewayAdapter;

// Returns the Nest document with the real controllers and DTOs. The application is closed before
// returning; it is never listening.
async function createSwaggerDocumentObject(): Promise<JsonObject> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config: generatorConfig,
        originSecret: placeholderOriginSecret,
        logger: new JsonLogger(),
      }),
    ],
  })
    .overrideProvider(DYNAMODB_DOCUMENT_CLIENT)
    .useValue(unusedDocumentClient)
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(unusedPaymentGateway)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.setGlobalPrefix(GLOBAL_PREFIX);
  try {
    const builder = new DocumentBuilder()
      .setTitle('Card checkout API')
      .setDescription(
        'Products, customers, transactions and deliveries for the card checkout store.',
      )
      .setVersion('1.0.0')
      .build();
    return JSON.parse(JSON.stringify(SwaggerModule.createDocument(app, builder))) as JsonObject;
  } finally {
    await app.close();
  }
}

function errorEnvelopeSchema(): JsonObject {
  const codes = Object.keys(ERROR_CATALOG) as ErrorCode[];
  const errorCodes: JsonObject = {};
  for (const code of codes) {
    errorCodes[code] = { status: ERROR_CATALOG[code].status, message: ERROR_CATALOG[code].message };
  }
  return {
    type: 'object',
    required: ['statusCode', 'code', 'message', 'details'],
    properties: {
      statusCode: { type: 'integer', example: 404 },
      code: { type: 'string', enum: codes, example: 'PRODUCT_NOT_FOUND' },
      message: { type: 'string', example: 'Product not found.' },
      details: { type: 'array', items: { type: 'string' } },
    },
    'x-error-codes': errorCodes,
  };
}

// The Error_Envelope schema is the catalog's body shape. Every `$ref` to the DTO is redirected to it.
function withErrorEnvelope(document: JsonObject): JsonObject {
  const components = document.components as JsonObject;
  const schemas = components.schemas as JsonObject;
  delete schemas[ERROR_ENVELOPE_DTO_SCHEMA];
  schemas[ERROR_ENVELOPE_SCHEMA] = errorEnvelopeSchema();
  return document;
}

// Sorts object keys at every depth. Arrays keep their order because it carries meaning
// (for example `required` or `parameters`).
function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key] as JsonValue);
    }
    return sorted;
  }
  return value === ERROR_ENVELOPE_DTO_REF ? ERROR_ENVELOPE_REF : value;
}

/** Returns the OpenAPI document as the exact text written to docs/openapi.json. */
export async function renderOpenApiJson(): Promise<string> {
  const document = withErrorEnvelope(await createSwaggerDocumentObject());
  return `${JSON.stringify(canonicalize(document), null, 2)}\n`;
}

async function main(): Promise<void> {
  const json = await renderOpenApiJson();
  mkdirSync(dirname(OPENAPI_OUTPUT_PATH), { recursive: true });
  writeFileSync(OPENAPI_OUTPUT_PATH, json, 'utf8');
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `openapi: generation failed (${error instanceof Error ? error.name : 'unknown error'})\n`,
    );
    process.exitCode = 1;
  });
}
