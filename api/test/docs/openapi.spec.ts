import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  OPENAPI_OUTPUT_PATH,
  PLACEHOLDER_ORIGIN_VERIFY_VALUE,
  renderOpenApiJson,
} from '../../scripts/generate-openapi';

// Each render builds the Nest module graph, which takes a few seconds on CI runners.
const RENDER_TIMEOUT_MS = 60_000;
const SRC_ROOT = resolve(__dirname, '..', '..', 'src');

// Operations from the API contract table in .kiro/steering/api-contract.md. The optional webhook
// is not listed because its controller lands in a later task.
const CONTRACT: readonly { method: string; path: string; statuses: readonly string[] }[] = [
  { method: 'get', path: '/api/v1/health', statuses: ['200'] },
  { method: 'get', path: '/api/v1/products', statuses: ['200'] },
  { method: 'get', path: '/api/v1/products/{id}', statuses: ['200', '404'] },
  { method: 'get', path: '/api/v1/fees', statuses: ['200'] },
  { method: 'get', path: '/api/v1/acceptance-tokens', statuses: ['200', '502'] },
  { method: 'post', path: '/api/v1/customers', statuses: ['201', '200', '400'] },
  { method: 'get', path: '/api/v1/customers/{id}', statuses: ['200', '404'] },
  {
    method: 'post',
    path: '/api/v1/transactions',
    statuses: ['201', '200', '400', '404', '409', '415', '422', '429', '502'],
  },
  { method: 'get', path: '/api/v1/transactions/{id}', statuses: ['200', '404'] },
  { method: 'get', path: '/api/v1/deliveries/{id}', statuses: ['200', '404'] },
];

// Matches the shape of a provider key or a secret value, such as "prv_" or "secret_" followed by
// a long run of characters. Descriptive text never matches it.
const CREDENTIAL_SHAPE = /\b(?:prv|sk|secret)_[A-Za-z0-9]{8,}/i;

type OpenApiDocument = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, unknown>; parameters?: unknown[] }>
  >;
  components: { schemas: Record<string, unknown> };
};

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      collectStrings(item, into);
    }
  }
  return into;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('OpenAPI document generation', () => {
  let first: string;
  let second: string;
  let document: OpenApiDocument;

  beforeAll(async () => {
    first = await renderOpenApiJson();
    second = await renderOpenApiJson();
    document = JSON.parse(first) as OpenApiDocument;
  }, RENDER_TIMEOUT_MS);

  it('produces identical bytes on two runs', () => {
    expect(Buffer.from(second, 'utf8').equals(Buffer.from(first, 'utf8'))).toBe(true);
  });

  it('ends with a single newline and uses two-space indentation', () => {
    expect(first.endsWith('}\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    expect(first.split('\n')[1]?.startsWith('  "')).toBe(true);
  });

  it('matches the committed docs/openapi.json', () => {
    expect(first).toBe(readFileSync(OPENAPI_OUTPUT_PATH, 'utf8'));
  });

  it.each(CONTRACT)('$method $path documents statuses $statuses', ({ method, path, statuses }) => {
    const operation = document.paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining([...statuses]));
  });

  it('documents the Idempotency-Key header as required on POST /transactions', () => {
    const operation = document.paths['/api/v1/transactions']?.post;
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
  });

  it('replaces the DTO schema with the Error_Envelope schema built from ERROR_CATALOG', () => {
    const schemas = document.components.schemas;
    expect(schemas).not.toHaveProperty('ErrorEnvelopeDto');
    expect(first).not.toContain('ErrorEnvelopeDto');
    expect(schemas['ErrorEnvelope']).toMatchObject({
      type: 'object',
      required: ['statusCode', 'code', 'message', 'details'],
      properties: { code: { enum: expect.arrayContaining(['PRODUCT_NOT_FOUND']) } },
      'x-error-codes': {
        PRODUCT_NOT_FOUND: { status: 404 },
        INSUFFICIENT_STOCK: { status: 409 },
        PAYMENT_PROVIDER_ERROR: { status: 502 },
      },
    });
  });

  it('holds no credential-like value and no generator placeholder', () => {
    const strings = collectStrings(document);
    expect(strings.filter((text) => CREDENTIAL_SHAPE.test(text))).toEqual([]);
    expect(first).not.toContain(PLACEHOLDER_ORIGIN_VERIFY_VALUE);
  });

  it('never calls SwaggerModule.setup anywhere in api/src', () => {
    const offenders = listSourceFiles(SRC_ROOT).filter((file) =>
      /SwaggerModule\s*\.\s*setup\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
