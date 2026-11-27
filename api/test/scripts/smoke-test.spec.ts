import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/smoke-test.sh');
const MAX_ATTEMPTS = 5;
const HEALTH_BODY = '{"status":"ok"}';
const DOCS_IMG_SRC = "img-src 'self' data:";
const REQUIRED_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
];
// The web policy has no data: images. The docs policy differs only in img-src.
const WEB_CSP = "default-src 'self'; img-src 'self'";
const DOCS_CSP = "default-src 'self'; img-src 'self' data:";
const CSP_VALUES = [
  WEB_CSP,
  DOCS_CSP,
  "default-src 'self'; img-src 'self' data:x",
  "default-src 'self'; img-src 'self' data :",
  "img-src 'self'",
];

type CheckKind = 'page' | 'plain' | 'health' | 'docs';
type PlanKey = 'root' | 'health' | 'docs' | 'openapi';

interface Check {
  name: string;
  path: string;
  kind: CheckKind;
  plan: PlanKey;
}

// Same order as scripts/smoke-test.sh.
const CHECKS: readonly Check[] = [
  { name: 'GET /', path: '/', kind: 'page', plan: 'root' },
  { name: 'GET /api/v1/health', path: '/api/v1/health', kind: 'health', plan: 'health' },
  { name: 'GET /docs/', path: '/docs/', kind: 'docs', plan: 'docs' },
  { name: 'GET /docs/openapi.json', path: '/docs/openapi.json', kind: 'plain', plan: 'openapi' },
];

/**
 * Number of fast-check runs for the main property. Each run starts one bash
 * process and up to twenty curl processes against a local server, so 100 runs
 * stay well under the test timeout.
 */
const NUM_RUNS = 100;

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Plan = Record<PlanKey, FakeResponse[]>;

interface Outcome {
  ok: boolean;
  failedCheck: Check | undefined;
  requests: Record<string, number>;
}

interface ScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface PlanRun extends ScriptResult {
  requests: Record<string, number>;
  originVerifySeen: boolean;
  leftovers: string[];
}

let currentPlan: Plan = {} as Plan;
let received: Record<string, number> = {};
let originVerifySeen = false;
let baseUrl = '';
let server: https.Server;
let certDir = '';
let caCertPath = '';

/** Mirrors the script rule: the last response is repeated when the list is exhausted. */
function responseAt(responses: FakeResponse[], attempt: number): FakeResponse {
  return responses[Math.min(attempt, responses.length - 1)];
}

/** Model of a single check: the same rules as scripts/smoke-test.sh. */
function isPass(response: FakeResponse, check: Check): boolean {
  if (response.status !== 200) {
    return false;
  }
  const headers = new Map(
    Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  if (!REQUIRED_HEADERS.every((header) => headers.has(header))) {
    return false;
  }
  if (check.kind === 'docs') {
    return (headers.get('content-security-policy') ?? '').includes(DOCS_IMG_SRC);
  }
  if (check.kind === 'health') {
    // Command substitution in bash strips trailing newlines before comparing.
    return response.body.replace(/\n+$/, '') === HEALTH_BODY;
  }
  return true;
}

/** Expected result of the whole script for a plan, including the requests each path receives. */
function expectedOutcome(plan: Plan): Outcome {
  const requests: Record<string, number> = Object.fromEntries(
    CHECKS.map((check) => [check.path, 0]),
  );
  for (const check of CHECKS) {
    const responses = plan[check.plan];
    let passed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !passed; attempt++) {
      requests[check.path] += 1;
      passed = isPass(responseAt(responses, attempt), check);
    }
    if (!passed) {
      return { ok: false, failedCheck: check, requests };
    }
  }
  return { ok: true, failedCheck: undefined, requests };
}

function requestCounts(): Record<string, number> {
  return Object.fromEntries(CHECKS.map((check) => [check.path, received[check.path] ?? 0]));
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.headers['x-origin-verify'] !== undefined) {
    originVerifySeen = true;
  }

  const url = req.url ?? '';
  const check = CHECKS.find((candidate) => candidate.path === url);
  if (check === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }

  const attempt = received[url] ?? 0;
  received[url] = attempt + 1;
  const response = responseAt(currentPlan[check.plan], attempt);
  res.writeHead(response.status, response.headers);
  res.end(response.body);
}

function runScript(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT_PATH, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        SMOKE_RETRY_DELAY: '0',
        TMPDIR: options.cwd,
        // The local server presents a throwaway self-signed certificate that curl must trust.
        CURL_CA_BUNDLE: caCertPath,
        ...options.env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** Runs the script against a server that serves the given plan, in an empty temp directory. */
async function runPlan(plan: Plan): Promise<PlanRun> {
  currentPlan = plan;
  received = {};
  originVerifySeen = false;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-spec-'));
  try {
    const result = await runScript([baseUrl], { cwd: workDir });
    return {
      ...result,
      requests: requestCounts(),
      originVerifySeen,
      leftovers: fs.readdirSync(workDir),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Plan in which every check passes on the first attempt. Tests override only what they need. */
function passingPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    root: [successfulResponse],
    health: [successfulResponse],
    docs: [successfulDocsResponse],
    openapi: [successfulResponse],
    ...overrides,
  };
}

function securityHeaders(csp: string): Record<string, string> {
  return Object.fromEntries(
    REQUIRED_HEADERS.map((header) => [header, header === 'content-security-policy' ? csp : '1']),
  );
}

const successfulResponse: FakeResponse = {
  status: 200,
  headers: securityHeaders(WEB_CSP),
  body: HEALTH_BODY,
};

const successfulDocsResponse: FakeResponse = {
  status: 200,
  headers: securityHeaders(DOCS_CSP),
  body: '<!doctype html>',
};

const failingResponse: FakeResponse = {
  status: 500,
  headers: {},
  body: 'error',
};

const statusArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(200) },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 200, max: 599 })
      .filter((status) => status !== 204 && status !== 304),
  },
);

const headerNamesArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant([...REQUIRED_HEADERS]) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...REQUIRED_HEADERS)
      .map((dropped) => REQUIRED_HEADERS.filter((header) => header !== dropped)),
  },
  { weight: 1, arbitrary: fc.subarray([...REQUIRED_HEADERS]) },
);

const headersArb: fc.Arbitrary<Record<string, string>> = fc
  .record({
    names: headerNamesArb,
    upperCase: fc.boolean(),
    csp: fc.constantFrom(...CSP_VALUES),
  })
  .map(({ names, upperCase, csp }) =>
    Object.fromEntries(
      [...names].map((name): [string, string] => [
        upperCase ? name.toUpperCase() : name,
        name === 'content-security-policy' ? csp : '1',
      ]),
    ),
  );

const bodyArb = fc.oneof(
  fc.constantFrom(
    HEALTH_BODY,
    `${HEALTH_BODY}\n`,
    `${HEALTH_BODY}\n\n`,
    '{"status":"down"}',
    '',
    `${HEALTH_BODY} `,
  ),
  fc.string({ maxLength: 40 }),
);

const responseArb: fc.Arbitrary<FakeResponse> = fc.record({
  status: statusArb,
  headers: headersArb,
  body: bodyArb,
});

const planArb: fc.Arbitrary<Plan> = fc.record({
  root: fc.array(responseArb, { minLength: 1, maxLength: 6 }),
  health: fc.array(responseArb, { minLength: 1, maxLength: 6 }),
  docs: fc.array(responseArb, { minLength: 1, maxLength: 6 }),
  openapi: fc.array(responseArb, { minLength: 1, maxLength: 6 }),
});

/** Creates a throwaway self-signed certificate for 127.0.0.1 and returns the PEM contents. */
function createLocalCertificate(): { key: string; cert: string; certPath: string } {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-cert-'));
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return {
    key: fs.readFileSync(keyPath, 'utf8'),
    cert: fs.readFileSync(certPath, 'utf8'),
    certPath,
  };
}
describe('scripts/smoke-test.sh', () => {
  beforeAll(async () => {
    const { key, cert, certPath } = createLocalCertificate();
    caCertPath = certPath;
    server = https.createServer({ key, cert }, handleRequest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(certDir, { recursive: true, force: true });
  });
  it('Property 16: smoke test passes if and only if status, headers and body are all correct', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const run = await runPlan(plan);
        const expected = expectedOutcome(plan);

        expect(run.exitCode === 0).toBe(expected.ok);
        if (expected.failedCheck) {
          const name = expected.failedCheck.name;
          expect(run.stderr.split('\n').some((line) => line.startsWith(`FAILED: ${name} `))).toBe(
            true,
          );
          expect(run.requests[expected.failedCheck.path]).toBe(MAX_ATTEMPTS);
        } else {
          expect(run.stderr).not.toContain('FAILED');
        }
        expect(run.requests).toEqual(expected.requests);
        expect(run.originVerifySeen).toBe(false);
        expect(run.leftovers).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  it('passes when a transient failure is followed by success', async () => {
    const run = await runPlan(
      passingPlan({ root: [failingResponse, successfulResponse], health: [successfulResponse] }),
    );

    expect(run.exitCode).toBe(0);
    expect(run.requests).toEqual({
      '/': 2,
      '/api/v1/health': 1,
      '/docs/': 1,
      '/docs/openapi.json': 1,
    });
    expect(run.stdout).toContain('OK: GET /');
    expect(run.stdout).toContain('OK: GET /api/v1/health');
    expect(run.stdout).toContain('OK: GET /docs/');
    expect(run.stdout).toContain('OK: GET /docs/openapi.json');
  });

  it('fails with exactly 5 requests when the root check never passes', async () => {
    const run = await runPlan(passingPlan({ root: [failingResponse] }));

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('FAILED: GET / status 500');
    expect(run.requests).toEqual({
      '/': MAX_ATTEMPTS,
      '/api/v1/health': 0,
      '/docs/': 0,
      '/docs/openapi.json': 0,
    });
  });

  it('names the missing header in the failed health check', async () => {
    const withoutFrameOptions: FakeResponse = {
      ...successfulResponse,
      headers: Object.fromEntries(
        Object.entries(successfulResponse.headers).filter(([name]) => name !== 'x-frame-options'),
      ),
    };
    const run = await runPlan(passingPlan({ health: [withoutFrameOptions] }));

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('FAILED: GET /api/v1/health missing header x-frame-options');
    expect(run.requests).toEqual({
      '/': 1,
      '/api/v1/health': MAX_ATTEMPTS,
      '/docs/': 0,
      '/docs/openapi.json': 0,
    });
  });

  it('fails when GET /api/v1/health does not answer 200', async () => {
    const run = await runPlan(passingPlan({ health: [{ ...successfulResponse, status: 500 }] }));
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('FAILED: GET /api/v1/health');
    expect(run.requests).toEqual({
      '/': 1,
      '/api/v1/health': MAX_ATTEMPTS,
      '/docs/': 0,
      '/docs/openapi.json': 0,
    });
  });
  it('fails the docs check when the CSP does not allow data: images', async () => {
    const webPolicyOnDocs: FakeResponse = {
      ...successfulDocsResponse,
      headers: securityHeaders(WEB_CSP),
    };
    const run = await runPlan(passingPlan({ docs: [webPolicyOnDocs] }));

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(
      "FAILED: GET /docs/ content-security-policy without img-src 'self' data:",
    );
    expect(run.requests).toEqual({
      '/': 1,
      '/api/v1/health': 1,
      '/docs/': MAX_ATTEMPTS,
      '/docs/openapi.json': 0,
    });
  });

  it('fails when the OpenAPI document does not answer 200', async () => {
    const run = await runPlan(passingPlan({ openapi: [{ ...successfulResponse, status: 404 }] }));

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('FAILED: GET /docs/openapi.json status 404');
    expect(run.requests).toEqual({
      '/': 1,
      '/api/v1/health': 1,
      '/docs/': 1,
      '/docs/openapi.json': MAX_ATTEMPTS,
    });
  });

  describe('https-only', () => {
    const plainHttpUrl = (): string => baseUrl.replace('https://', 'http://');
    const rejectedUrls: ReadonlyArray<[string, () => string]> = [
      ['plain http', plainHttpUrl],
      ['ftp', () => 'ftp://127.0.0.1/'],
      ['file', () => 'file:///etc/hosts'],
      ['no scheme', () => '127.0.0.1:8443'],
      ['upper-case scheme', () => 'HTTPS://127.0.0.1'],
      ['leading space', () => ' https://127.0.0.1'],
    ];
    it.each(rejectedUrls)(
      'rejects a base URL with %s and sends no request',
      async (_label, url) => {
        currentPlan = passingPlan();
        received = {};
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-scheme-'));
        try {
          const run = await runScript([url()], { cwd: workDir });
          expect(run.exitCode).toBe(2);
          expect(run.stderr).toContain('must start with https://');
          expect(run.stdout).not.toContain('OK:');
          expect(received).toEqual({});
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      },
    );
    it('accepts an https base URL with a trailing slash', async () => {
      currentPlan = passingPlan();
      received = {};
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-slash-'));
      try {
        const run = await runScript([`${baseUrl}/`], { cwd: workDir });
        expect(run.exitCode).toBe(0);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
    it('restricts every curl call to https with --proto', () => {
      const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
      const curlCalls = script
        .split('\n')
        .filter((line) => /\bcurl\s/.test(line) && !/^\s*#/.test(line));
      expect(curlCalls.length).toBeGreaterThan(0);
      for (const call of curlCalls) {
        expect(call).toContain("--proto '=https'");
      }
    });
    it('detects a script copy whose scheme check was removed', async () => {
      const original = fs.readFileSync(SCRIPT_PATH, 'utf8');
      const mutated = original.replace('if [[ "$1" != https://* ]]; then', 'if false; then');
      expect(mutated).not.toEqual(original);
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-mutant-'));
      try {
        const mutantPath = path.join(workDir, 'mutant.sh');
        fs.writeFileSync(mutantPath, mutated);
        currentPlan = passingPlan();
        received = {};
        const run = await new Promise<ScriptResult>((resolve, reject) => {
          const child = spawn('bash', [mutantPath, plainHttpUrl()], {
            cwd: workDir,
            env: { ...process.env, SMOKE_RETRY_DELAY: '0', TMPDIR: workDir },
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('error', reject);
          child.on('close', (exitCode) => resolve({ exitCode, stdout: '', stderr }));
        });
        // Without the scheme check the script does not exit with the https-only error.
        expect(run.stderr).not.toContain('must start with https://');
        expect(run.exitCode).not.toBe(0);
        // The remaining --proto guard still stops curl before any plain-HTTP request is sent.
        expect(received).toEqual({});
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
  it('prints usage and exits non-zero without an argument', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-usage-'));
    try {
      const run = await runScript([], { cwd: workDir });
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain('Usage:');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-numeric SMOKE_RETRY_DELAY', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-delay-'));
    try {
      const run = await runScript([baseUrl], { cwd: workDir, env: { SMOKE_RETRY_DELAY: 'soon' } });
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain('SMOKE_RETRY_DELAY');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
