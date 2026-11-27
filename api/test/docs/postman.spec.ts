import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BASE_URL_VARIABLE,
  OPENAPI_INPUT_PATH,
  ORIGIN_VERIFY_VARIABLE,
  POSTMAN_OUTPUT_PATH,
  POSTMAN_SCHEMA_URL,
  RESOURCE_ORDER,
  renderPostmanJson,
} from '../../scripts/generate-postman';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const FORBIDDEN_WORDS_SCRIPT = resolve(REPO_ROOT, 'scripts', 'check-forbidden-words.sh');
// The word list is git-ignored. Where it is absent (CI runners), the CI workflow's own forbidden
// words step is the check that applies, so this test is skipped rather than failing on a missing file.
const FORBIDDEN_WORDS_LIST = resolve(REPO_ROOT, '.kiro', 'private', 'forbidden-words.txt');

const SCHEMA_URL_PATTERN = /collection\/v2\.1\.0\/collection\.json$/;
const CREDENTIAL_SHAPE = /\b(?:prv|pub|sk|secret)_[A-Za-z0-9]{8,}/i;
const BEARER_SHAPE = /\bBearer\s/i;
const LONG_OPAQUE_VALUE = /^[A-Za-z0-9+/=_-]{32,}$/;
const LONG_HEX_VALUE = /^[0-9a-f]{32,}$/i;
const ABSOLUTE_URL = /https?:\/\//i;

interface PostmanRequest {
  method: string;
  header: { key: string; value: string }[];
  url: { raw: string };
  body?: { raw: string };
}

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
}

interface PostmanCollection {
  info: { schema: string; name: string; description?: string };
  item: PostmanItem[];
  variable: { key: string; value: string }[];
}

interface Leaf {
  folder: string;
  request: PostmanRequest;
}

function leavesOf(items: PostmanItem[], folder: string): Leaf[] {
  return items.flatMap((item) => {
    if (item.request !== undefined) {
      return [{ folder, request: item.request }];
    }
    return leavesOf(item.item ?? [], item.name);
  });
}

function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      stringsOf(item, into);
    }
  }
  return into;
}

function headerValue(request: PostmanRequest, key: string): string | undefined {
  return request.header.find((header) => header.key === key)?.value;
}

// Operations from the OpenAPI document, written the way the collection writes them.
function expectedOperations(openApi: string): string[] {
  const document = JSON.parse(openApi) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map(
      (method) =>
        `${method.toUpperCase()} {{${BASE_URL_VARIABLE}}}${path.replace(/\{(\w+)\}/g, ':$1')}`,
    ),
  );
}

describe('Postman collection', () => {
  let openApi: string;
  let rendered: string;
  let collection: PostmanCollection;
  let leaves: Leaf[];

  beforeAll(() => {
    openApi = readFileSync(OPENAPI_INPUT_PATH, 'utf8');
    rendered = renderPostmanJson(openApi);
    collection = JSON.parse(rendered) as PostmanCollection;
    leaves = leavesOf(collection.item, '');
  });

  it('is a Postman Collection v2.1 document with info, items and variables', () => {
    expect(collection.info.schema).toBe(POSTMAN_SCHEMA_URL);
    expect(POSTMAN_SCHEMA_URL).toMatch(SCHEMA_URL_PATTERN);
    expect(collection.info.name).toBe('Payments API');
    expect(Array.isArray(collection.item)).toBe(true);
    expect(Array.isArray(collection.variable)).toBe(true);
  });

  it('defines baseUrl and originVerify as empty variables and no others', () => {
    expect(collection.variable).toEqual([
      { key: BASE_URL_VARIABLE, value: '' },
      { key: ORIGIN_VERIFY_VARIABLE, value: '' },
    ]);
  });

  it('groups requests into one folder per resource, in the documented order', () => {
    expect(collection.item.map((folder) => folder.name)).toEqual([...RESOURCE_ORDER]);
  });

  it('has exactly one request for every OpenAPI operation', () => {
    const actual = leaves.map(({ request }) => `${request.method} ${request.url.raw}`).sort();
    expect(actual).toEqual(expectedOperations(openApi).sort());
  });

  it('sends X-Origin-Verify from the originVerify variable on every request', () => {
    for (const { request } of leaves) {
      expect(headerValue(request, 'X-Origin-Verify')).toBe(`{{${ORIGIN_VERIFY_VARIABLE}}}`);
    }
  });

  it('sends Idempotency-Key only on POST /transactions, as a Postman dynamic value', () => {
    const withKey = leaves.filter(
      ({ request }) => headerValue(request, 'Idempotency-Key') !== undefined,
    );
    expect(withKey).toHaveLength(1);
    expect(withKey[0]?.request.method).toBe('POST');
    expect(withKey[0]?.request.url.raw).toBe(`{{${BASE_URL_VARIABLE}}}/api/v1/transactions`);
    expect(
      headerValue(
        withKey[0]?.request ?? { method: '', header: [], url: { raw: '' } },
        'Idempotency-Key',
      ),
    ).toBe('{{$guid}}');
  });

  it('gives every POST request a JSON body example', () => {
    const posts = leaves.filter(({ request }) => request.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const { request } of posts) {
      expect(headerValue(request, 'Content-Type')).toBe('application/json');
      expect(typeof JSON.parse(request.body?.raw ?? 'null')).toBe('object');
    }
  });

  it('only uses the baseUrl variable as the host and contains no absolute URL', () => {
    for (const { request } of leaves) {
      expect(request.url.raw.startsWith(`{{${BASE_URL_VARIABLE}}}/`)).toBe(true);
    }
    const withoutSchema = rendered.replace(POSTMAN_SCHEMA_URL, '');
    expect(ABSOLUTE_URL.test(withoutSchema)).toBe(false);
  });

  it('holds no credential-like value, bearer token or long opaque string', () => {
    const values = stringsOf(collection).filter((text) => text !== POSTMAN_SCHEMA_URL);
    const suspicious = values.filter(
      (text) =>
        CREDENTIAL_SHAPE.test(text) ||
        BEARER_SHAPE.test(text) ||
        LONG_OPAQUE_VALUE.test(text) ||
        LONG_HEX_VALUE.test(text),
    );
    expect(suspicious).toEqual([]);
  });

  it('writes the same bytes on every render and matches the committed file', () => {
    expect(renderPostmanJson(openApi)).toBe(rendered);
    expect(rendered.endsWith('}\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
    expect(readFileSync(POSTMAN_OUTPUT_PATH, 'utf8')).toBe(rendered);
  });

  const forbiddenWordsCheck = existsSync(FORBIDDEN_WORDS_LIST) ? it : it.skip;
  forbiddenWordsCheck('passes the repository forbidden words check', () => {
    const result = spawnSync('bash', [FORBIDDEN_WORDS_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});
