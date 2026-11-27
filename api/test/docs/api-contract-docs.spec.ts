import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ERROR_CATALOG } from '../../src/infrastructure/http/error-catalog';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const API_CONTRACT = resolve(REPO_ROOT, '.kiro', 'steering', 'api-contract.md');
const PAYMENT_GATEWAY = resolve(REPO_ROOT, '.kiro', 'steering', 'payment-gateway.md');
const DEPLOYMENT_DOC = resolve(REPO_ROOT, 'docs', 'deployment.md');
const README = resolve(REPO_ROOT, 'README.md');
const FORBIDDEN_WORDS_SCRIPT = resolve(REPO_ROOT, 'scripts', 'check-forbidden-words.sh');
// The word list is git-ignored. Where it is absent (CI runners), the CI forbidden-words step applies.
const FORBIDDEN_WORDS_LIST = resolve(REPO_ROOT, '.kiro', 'private', 'forbidden-words.txt');

// Requirement 13 criterion 3: every code and its HTTP status.
const REQUIREMENT_13_CODES: [string, number][] = [
  ['VALIDATION_ERROR', 400],
  ['MISSING_IDEMPOTENCY_KEY', 400],
  ['INVALID_SIGNATURE', 401],
  ['FORBIDDEN_ORIGIN', 403],
  ['PRODUCT_NOT_FOUND', 404],
  ['CUSTOMER_NOT_FOUND', 404],
  ['TRANSACTION_NOT_FOUND', 404],
  ['DELIVERY_NOT_FOUND', 404],
  ['ROUTE_NOT_FOUND', 404],
  ['INSUFFICIENT_STOCK', 409],
  ['IDEMPOTENCY_KEY_IN_PROGRESS', 409],
  ['PAYLOAD_TOO_LARGE', 413],
  ['UNSUPPORTED_MEDIA_TYPE', 415],
  ['IDEMPOTENCY_KEY_REUSED', 422],
  ['TOO_MANY_REQUESTS', 429],
  ['INTERNAL_ERROR', 500],
  ['PAYMENT_PROVIDER_ERROR', 502],
];

const CREDENTIAL_VALUE = /prv_[A-Za-z0-9]/;
const SEED_STEP = /seed\.ts|npm run seed|seed script|seed step/i;

function readDoc(path: string): string {
  return readFileSync(path, 'utf8');
}

// Text of one level-2 section, from its heading up to the next level-2 heading.
function sectionOf(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  if (start === -1) return '';
  const rest = doc.slice(start + 1);
  const next = rest.indexOf('\n## ', heading.length + 4);
  return next === -1 ? rest : rest.slice(0, next);
}

function rowPattern(code: string, status: number): RegExp {
  return new RegExp(`\\|\\s*\`${code}\`\\s*\\|\\s*${status}\\s*\\|`);
}

describe('API contract documentation', () => {
  const contract = readDoc(API_CONTRACT);

  it('the error catalog matches the codes and statuses of Requirement 13 criterion 3', () => {
    const catalog = Object.entries(ERROR_CATALOG).map(
      ([code, entry]) => [code, entry.status] as [string, number],
    );
    expect(catalog).toEqual(REQUIREMENT_13_CODES);
    expect(REQUIREMENT_13_CODES).toHaveLength(17);
  });

  it.each(REQUIREMENT_13_CODES)(
    'lists %s with HTTP status %i in the error table',
    (code, status) => {
      expect(contract).toMatch(rowPattern(code, status));
    },
  );

  it('lists the statusReason values PROVIDER_UNREACHABLE and AMOUNT_MISMATCH', () => {
    expect(contract).toContain('`PROVIDER_UNREACHABLE`');
    expect(contract).toContain('`AMOUNT_MISMATCH`');
  });

  it('documents the charset=utf-8 rule and 415 UNSUPPORTED_MEDIA_TYPE', () => {
    expect(contract).toContain('charset=utf-8');
    expect(contract).toMatch(/415 `UNSUPPORTED_MEDIA_TYPE`/);
  });

  it('documents the CloudFront-Viewer-Address rate limit key and excludes GET /health', () => {
    expect(contract).toContain('CloudFront-Viewer-Address');
    expect(contract).toMatch(/GET \/api\/v1\/health|`\/health`/);
    expect(contract).toMatch(/except `GET \/api\/v1\/health`/);
  });

  it('documents the Docs site under /docs/', () => {
    expect(contract).toContain('/docs/');
  });

  it('lists the POST /transactions responses 201, 200, 400, 404, 409, 415, 422, 429 and 502', () => {
    const row = contract.split('\n').find((line) => line.startsWith('| POST | `/transactions`'));
    expect(row).toBeDefined();
    for (const status of ['201', '200', '400', '404', '409', '415', '422', '429', '502']) {
      expect(row).toMatch(new RegExp(`\\b${status}\\b`));
    }
  });

  it('marks the webhook row as available only after branch 6 merges', () => {
    const row = contract.split('\n').find((line) => line.includes('/webhooks/payments'));
    expect(row).toContain('optional, available only after branch 6 merges');
  });

  it('documents 201 PENDING, and 502 as a Provider 4xx on the first creation attempt', () => {
    expect(contract).toMatch(/201, status PENDING/);
    expect(contract).toMatch(/Provider 4xx on the first creation attempt/);
  });

  it('documents the response shapes of acceptance-tokens, fees and products', () => {
    expect(contract).toContain('`GET /acceptance-tokens`');
    expect(contract).toContain('`acceptPersonalAuth`');
    expect(contract).toContain('`GET /fees`');
    expect(contract).toContain('`baseFeeInCents`');
    expect(contract).toContain('`GET /products`');
    expect(contract).toContain('`imageUrl`');
  });

  it('rejects amount properties with 400 and no longer says amounts are ignored', () => {
    expect(contract).not.toContain('Client-sent amounts are ignored');
    expect(contract).toMatch(/amount property[\s\S]*400 `VALIDATION_ERROR`/);
  });
});

describe('payment gateway steering', () => {
  const gateway = readDoc(PAYMENT_GATEWAY);
  const resilience = sectionOf(gateway, 'Resilience');

  it('has a Resilience section', () => {
    expect(resilience).not.toBe('');
  });

  it('names both the Standard_Profile and the Single_Attempt_Profile in Resilience', () => {
    expect(resilience).toContain('Standard_Profile');
    expect(resilience).toContain('Single_Attempt_Profile');
  });

  it('describes 201 PENDING, reconciliation by Reference and the 60 s window with PROVIDER_UNREACHABLE', () => {
    expect(resilience).toContain('201');
    expect(resilience).toContain('PENDING');
    expect(resilience).toMatch(/Reference/);
    expect(resilience).toMatch(/60 s/);
    expect(resilience).toContain('PROVIDER_UNREACHABLE');
  });

  it('describes the Amount_Check with AMOUNT_MISMATCH in Resilience', () => {
    expect(resilience).toContain('Amount_Check');
    expect(resilience).toContain('AMOUNT_MISMATCH');
  });

  it('keeps the Reference lookup (Sandbox result) heading', () => {
    expect(gateway).toMatch(/^## Reference lookup \(Sandbox result\)$/m);
  });
});

describe('deployment and README documentation', () => {
  const deployment = readDoc(DEPLOYMENT_DOC);
  const readme = readDoc(README);

  it('deployment verification checks /docs/ and /docs/openapi.json', () => {
    const verification = sectionOf(deployment, '7. Verification');
    expect(verification).toContain('/docs/');
    expect(verification).toContain('/docs/openapi.json');
  });

  it('README links to the docs site, the OpenAPI document and the Postman collection', () => {
    expect(readme).toContain('/docs/');
    expect(readme).toContain('docs/openapi.json');
    expect(readme).toContain('docs/postman/payments-api.postman_collection.json');
  });

  it('README documents the rate limit', () => {
    expect(readme).toContain('60 requests');
    expect(readme).toContain('CloudFront-Viewer-Address');
  });

  it.each([
    ['docs/deployment.md', deployment],
    ['README.md', readme],
  ])('%s has no seed step', (_name, text) => {
    expect(text).not.toMatch(SEED_STEP);
  });

  it.each([
    ['.kiro/steering/api-contract.md', readDoc(API_CONTRACT)],
    ['.kiro/steering/payment-gateway.md', readDoc(PAYMENT_GATEWAY)],
    ['docs/deployment.md', deployment],
    ['README.md', readme],
  ])('%s holds no private key value', (_name, text) => {
    expect(text).not.toMatch(CREDENTIAL_VALUE);
  });
});

describe('forbidden words', () => {
  const forbiddenWordsCheck = existsSync(FORBIDDEN_WORDS_LIST) ? it : it.skip;

  forbiddenWordsCheck('passes the repository forbidden words check', () => {
    const result = spawnSync('bash', [FORBIDDEN_WORDS_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});
