import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..');
const BUNDLE_LIMIT_BYTES = 10 * 1024 * 1024;
const ORIGIN_SECRET_VALUE = 'stub-origin-secret-value-0001';
const ORIGIN_SECRET_PARAM = '/test/origin/verify-secret';

let outDir: string;
let bundlePath: string;

interface PackageJson {
  scripts: Record<string, string>;
}

const readPackageJson = (): PackageJson =>
  JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8')) as PackageJson;

// Collects the values of the local env files. Only keys are ever reported, never values.
function readLocalEnvEntries(): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const file of [join(apiRoot, '.env'), join(repoRoot, '.env')]) {
    if (!existsSync(file)) {
      continue;
    }
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match === null) {
        continue;
      }
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      entries.push({ key: match[1], value });
    }
  }
  return entries;
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'lambda-bundle-'));
  const tsxCli = require.resolve('tsx/cli');
  const result = spawnSync(
    process.execPath,
    [tsxCli, join(apiRoot, 'scripts', 'build-lambda.ts'), outDir],
    { cwd: apiRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Bundle build failed:\n${result.stdout}\n${result.stderr}`);
  }
  bundlePath = join(outDir, 'lambda.js');
}, 180_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('Lambda bundle output (task 7.16)', () => {
  it('writes exactly one file, lambda.js, to the output directory', () => {
    expect(readdirSync(outDir)).toEqual(['lambda.js']);
  });

  it('is smaller than 10 MB', () => {
    expect(statSync(bundlePath).size).toBeLessThan(BUNDLE_LIMIT_BYTES);
  });

  it('exports a handler function when required', () => {
    const script = 'const m = require(process.argv[1]); process.stdout.write(typeof m.handler);';
    const result = spawnSync(process.execPath, ['-e', script, bundlePath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('function');
  });

  it('contains no value from the local .env files', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    const leakedKeys = readLocalEnvEntries()
      .filter(({ value }) => value.length >= 8 && bundle.includes(value))
      .map(({ key }) => key);
    expect(leakedKeys).toEqual([]);
  });

  it('contains no payment private key prefix', () => {
    expect(readFileSync(bundlePath, 'utf8')).not.toMatch(/prv_[A-Za-z0-9_]{8,}/);
  });

  it('keeps the packaging scripts aligned with deploy.yml', () => {
    const { scripts } = readPackageJson();
    expect(scripts).not.toHaveProperty('package');
    expect(scripts.build).toMatch(/build-lambda\.ts\s*$/);
    expect(scripts.build).not.toContain('&&');
  });
});

interface Invocation {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ssmCallsSoFar: number;
}

interface SsmStub {
  server: Server;
  endpoint: string;
  calls: () => number;
}

function startSsmStub(): Promise<SsmStub> {
  let getParameterCalls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const target = request.headers['x-amz-target'];
      if (target === 'AmazonSSM.GetParameter') {
        getParameterCalls += 1;
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        response.end(
          JSON.stringify({
            Parameter: {
              Name: ORIGIN_SECRET_PARAM,
              Type: 'SecureString',
              Value: ORIGIN_SECRET_VALUE,
              Version: 1,
            },
          }),
        );
        return;
      }
      response.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
      response.end(JSON.stringify({ __type: 'UnknownOperationException' }));
    });
  });
  return new Promise((resolveStub) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveStub({
        server,
        endpoint: `http://127.0.0.1:${port}`,
        calls: () => getParameterCalls,
      });
    });
  });
}

const RESULT_PREFIX = 'RESULT ';

// Runs inside the child process: one cold start, then one line of JSON per invocation.
const CHILD_SCRIPT = `
const { handler } = require(process.argv[1]);
const makeEvent = (headers) => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: '/api/v1/health',
  rawQueryString: '',
  headers,
  requestContext: {
    accountId: '000000000000',
    apiId: 'function-url',
    domainName: 'example.lambda-url.us-east-1.on.aws',
    domainPrefix: 'example',
    http: {
      method: 'GET',
      path: '/api/v1/health',
      protocol: 'HTTP/1.1',
      sourceIp: '203.0.113.10',
      userAgent: 'jest',
    },
    requestId: 'req-1',
    routeKey: '$default',
    stage: '$default',
    time: '01/Jan/2026:00:00:00 +0000',
    timeEpoch: 1767225600000,
  },
  isBase64Encoded: false,
});
const secret = process.env.TEST_ORIGIN_SECRET;
const events = [
  makeEvent({ 'x-origin-verify': secret }),
  makeEvent({ 'x-origin-verify': secret }),
  makeEvent({}),
];
(async () => {
  for (const event of events) {
    const result = await handler(event, { callbackWaitsForEmptyEventLoop: false });
    process.stdout.write('RESULT ' + JSON.stringify({ statusCode: result.statusCode, headers: result.headers || {}, body: result.body }) + '\\n');
  }
})().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exit(1);
});
`;

function runBundledInvocations(stub: SsmStub): Promise<Invocation[]> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL_SSM: stub.endpoint,
    AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret-access-key-for-tests',
    AWS_EC2_METADATA_DISABLED: 'true',
    PAYMENT_API_URL: 'https://payment.example.test/v1',
    PAYMENT_PUBLIC_KEY: 'pub_test_fake',
    PAYMENT_PRIVATE_KEY_PARAM: '/test/payment/private-key',
    PAYMENT_INTEGRITY_SECRET_PARAM: '/test/payment/integrity-secret',
    PAYMENT_EVENTS_SECRET_PARAM: '/test/payment/events-secret',
    ORIGIN_VERIFY_SECRET_PARAM: ORIGIN_SECRET_PARAM,
    BASE_FEE_IN_CENTS: '300000',
    DELIVERY_FEE_IN_CENTS: '800000',
    DYNAMODB_TABLE_PRODUCTS: 'test-products',
    DYNAMODB_TABLE_CUSTOMERS: 'test-customers',
    DYNAMODB_TABLE_TRANSACTIONS: 'test-transactions',
    DYNAMODB_TABLE_DELIVERIES: 'test-deliveries',
    DYNAMODB_TABLE_IDEMPOTENCY_KEYS: 'test-idempotency-keys',
    TEST_ORIGIN_SECRET: ORIGIN_SECRET_VALUE,
  };
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, bundlePath], { env });
    const invocations: Invocation[] = [];
    let pending = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        // The application also writes JSON logs to stdout; only marked lines are results.
        if (line.startsWith(RESULT_PREFIX)) {
          const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as Omit<
            Invocation,
            'ssmCallsSoFar'
          >;
          invocations.push({ ...parsed, ssmCallsSoFar: stub.calls() });
        }
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun(invocations);
      } else {
        rejectRun(new Error(`Bundle boot process exited with ${String(code)}: ${stderr}`));
      }
    });
  });
}

describe('Bundled boot test (Requirement 10.1a)', () => {
  let stub: SsmStub;
  let invocations: Invocation[];

  beforeAll(async () => {
    stub = await startSsmStub();
    invocations = await runBundledInvocations(stub);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((done) => stub.server.close(() => done()));
  });

  it('answers GET /api/v1/health with 200 and {"status":"ok"} on cold start', () => {
    expect(invocations[0].statusCode).toBe(200);
    expect(JSON.parse(invocations[0].body)).toEqual({ status: 'ok' });
    expect(invocations[0].ssmCallsSoFar).toBe(1);
  });

  it('sends Cache-Control: no-store and no ETag on every response', () => {
    for (const invocation of invocations) {
      expect(invocation.headers['cache-control']).toBe('no-store');
      expect(invocation.headers['etag']).toBeUndefined();
    }
  });
  it('does not call SSM again on the second invocation', () => {
    expect(invocations[1].statusCode).toBe(200);
    expect(invocations[1].ssmCallsSoFar).toBe(1);
  });

  it('rejects a request without X-Origin-Verify with 403 and no extra SSM call', () => {
    expect(invocations[2].statusCode).toBe(403);
    expect(invocations[2].ssmCallsSoFar).toBe(1);
    expect(stub.calls()).toBe(1);
  });
});
