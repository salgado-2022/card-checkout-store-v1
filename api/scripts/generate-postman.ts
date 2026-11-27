import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Converts docs/openapi.json into a Postman Collection v2.1 file. Nothing here reads secrets, calls
// AWS or calls the payment provider. The collection holds two empty variables (baseUrl and
// originVerify) and examples taken from the OpenAPI schemas, so the output is safe to commit.

export const OPENAPI_INPUT_PATH = resolve(__dirname, '..', '..', 'docs', 'openapi.json');
export const POSTMAN_OUTPUT_PATH = resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'postman',
  'payments-api.postman_collection.json',
);
export const POSTMAN_SCHEMA_URL =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
export const BASE_URL_VARIABLE = 'baseUrl';
export const ORIGIN_VERIFY_VARIABLE = 'originVerify';
// Folder order in the collection. A resource missing from this list is appended alphabetically.
export const RESOURCE_ORDER: readonly string[] = [
  'health',
  'products',
  'fees',
  'acceptance-tokens',
  'customers',
  'transactions',
  'deliveries',
];

const API_PREFIX = '/api/v1/';
const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
// Postman creates a new value for every request, so the file never holds a fixed identifier.
const IDEMPOTENCY_VALUE = '{{$guid}}';
// Same shape as the identifiers in the OpenAPI examples.
const PATH_PARAM_EXAMPLE = '01HZX0000000000000000000AB';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface Schema {
  $ref?: string;
  example?: JsonValue;
  enum?: JsonValue[];
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  minimum?: number;
}

interface Operation {
  summary?: string;
  parameters?: { name: string; in: string }[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}

interface OpenApiDocument {
  info: { description?: string };
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components?: { schemas?: Record<string, Schema> };
}

function schemaByRef(ref: string, schemas: Record<string, Schema>): Schema {
  const name = ref.slice(ref.lastIndexOf('/') + 1);
  const schema = schemas[name];
  if (schema === undefined) {
    throw new Error(`unknown schema reference ${ref}`);
  }
  return schema;
}

// Builds the example value of a schema: its own `example`, else the first enum value, else the
// properties, items or a neutral default for the type.
function exampleOf(schema: Schema | undefined, schemas: Record<string, Schema>): JsonValue {
  if (schema === undefined) {
    return null;
  }
  if (schema.$ref !== undefined) {
    return exampleOf(schemaByRef(schema.$ref, schemas), schemas);
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (schema.enum !== undefined) {
    return schema.enum[0] ?? null;
  }
  if (schema.properties !== undefined) {
    const object: JsonObject = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      object[key] = exampleOf(property, schemas);
    }
    return object;
  }
  if (schema.items !== undefined) {
    return [exampleOf(schema.items, schemas)];
  }
  switch (schema.type) {
    case 'integer':
    case 'number':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      return '';
  }
}

// Postman writes path parameters as `:name`.
function postmanPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '');
}

function resourceOf(path: string): string {
  if (!path.startsWith(API_PREFIX)) {
    throw new Error(`path outside ${API_PREFIX}: ${path}`);
  }
  return path.slice(API_PREFIX.length).split('/')[0] ?? '';
}

function buildItem(
  path: string,
  method: HttpMethod,
  operation: Operation,
  schemas: Record<string, Schema>,
): JsonObject {
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  const headers: JsonObject[] = [];
  if (bodySchema !== undefined) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
  }
  if (
    operation.parameters?.some(
      (param) => param.in === 'header' && param.name === IDEMPOTENCY_HEADER,
    )
  ) {
    headers.push({ key: IDEMPOTENCY_HEADER, value: IDEMPOTENCY_VALUE });
  }
  headers.push({ key: ORIGIN_VERIFY_HEADER, value: `{{${ORIGIN_VERIFY_VARIABLE}}}` });

  const params = pathParamNames(path);
  const request: JsonObject = {
    method: method.toUpperCase(),
    header: headers,
    url: {
      raw: `{{${BASE_URL_VARIABLE}}}${postmanPath(path)}`,
      host: [`{{${BASE_URL_VARIABLE}}}`],
      path: postmanPath(path).slice(1).split('/'),
      ...(params.length > 0
        ? { variable: params.map((key) => ({ key, value: PATH_PARAM_EXAMPLE })) }
        : {}),
    },
  };
  if (bodySchema !== undefined) {
    request.body = {
      mode: 'raw',
      options: { raw: { language: 'json' } },
      raw: JSON.stringify(exampleOf(bodySchema, schemas), null, 2),
    };
  }
  return {
    name: operation.summary ?? `${method.toUpperCase()} ${path}`,
    request,
  };
}

// Sorts object keys at every depth. Arrays keep their order.
function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key] as JsonValue);
    }
    return sorted;
  }
  return value;
}

function folderRank(resource: string): number {
  const index = RESOURCE_ORDER.indexOf(resource);
  return index === -1 ? RESOURCE_ORDER.length : index;
}

/** Returns the Postman collection as the exact text written to the output file. */
export function renderPostmanJson(openApiText: string): string {
  const document = JSON.parse(openApiText) as OpenApiDocument;
  const schemas = document.components?.schemas ?? {};
  const folders = new Map<string, JsonObject[]>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    const resource = resourceOf(path);
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) {
        continue;
      }
      const items = folders.get(resource) ?? [];
      items.push(buildItem(path, method, operation, schemas));
      folders.set(resource, items);
    }
  }
  const collection: JsonObject = {
    info: {
      name: 'Payments API',
      description:
        `${document.info.description ?? ''} Set baseUrl and originVerify before sending requests.`.trim(),
      schema: POSTMAN_SCHEMA_URL,
    },
    item: [...folders.entries()]
      .sort(([a], [b]) => folderRank(a) - folderRank(b) || a.localeCompare(b))
      .map(([name, items]) => ({ name, item: items })),
    variable: [
      { key: BASE_URL_VARIABLE, value: '' },
      { key: ORIGIN_VERIFY_VARIABLE, value: '' },
    ],
  };
  return `${JSON.stringify(sortKeys(collection), null, 2)}\n`;
}

function main(): void {
  const json = renderPostmanJson(readFileSync(OPENAPI_INPUT_PATH, 'utf8'));
  mkdirSync(dirname(POSTMAN_OUTPUT_PATH), { recursive: true });
  writeFileSync(POSTMAN_OUTPUT_PATH, json, 'utf8');
  process.stdout.write(`Postman collection written to ${POSTMAN_OUTPUT_PATH}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(
      `postman: generation failed (${error instanceof Error ? error.message : 'unknown error'})\n`,
    );
    process.exitCode = 1;
  }
}
