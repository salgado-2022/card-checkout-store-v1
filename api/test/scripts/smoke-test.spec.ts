import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/smoke-test.sh');
const MAX_ATTEMPTS = 5;
const HEALTH_BODY = '{"status":"ok"}';
const REQUIRED_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
];

interface Check {
  name: string;
  path: string;
}

const ROOT: Check = { name: 'GET /', path: '/' };
const HEALTH: Check = { name: 'GET /api/v1/health', path: '/api/v1/health' };

/**
 * Number of fast-check runs for the main property. Each run starts one bash
 * process and up to ten curl processes against a local server (about 50 ms in
 * total), so 100 runs keep the property well under 30 seconds.
 */
const NUM_RUNS = 100;

interface FakeResponse {
  status: number;
  headerNames: string[];
  body: string;
}

interface Plan {
  root: FakeResponse[];
  health: FakeResponse[];
}

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

let currentPlan: Plan = { root: [], health: [] };
let received: Record<string, number> = {};
let originVerifySeen = false;
let baseUrl = '';
let server: http.Server;

/** Mirrors the script rule: the last attempt index is repeated when the list is exhausted. */
function responseAt(responses: FakeResponse[], attempt: number): FakeResponse {
  return responses[Math.min(attempt, responses.length - 1)];
}

/** Model of a single check: the same rules as scripts/smoke-test.sh. */
function isPass(response: FakeResponse, check: Check): boolean {
  if (response.status !== 200) {
    return false;
  }
  const names = response.headerNames.map((name) => name.toLowerCase());
  if (!REQUIRED_HEADERS.every((header) => names.includes(header))) {
    return false;
  }
  // Command substitution in bash strips trailing newlines before comparing.
  return check.path !== HEALTH.path || response.body.replace(/\n+$/, '') === HEALTH_BODY;
}

/** Expected result of the whole script for a plan, including the requests each path receives. */
function expectedOutcome(plan: Plan): Outcome {
  const requests: Record<string, number> = { [ROOT.path]: 0, [HEALTH.path]: 0 };
  const steps: [Check, FakeResponse[]][] = [
    [ROOT, plan.root],
    [HEALTH, plan.health],
  ];

  for (const [check, responses] of steps) {
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

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.headers['x-origin-verify'] !== undefined) {
    originVerifySeen = true;
  }

  const url = req.url ?? '';
  let responses: FakeResponse[] | undefined;
  if (url === ROOT.path) {
    responses = currentPlan.root;
  } else if (url === HEALTH.path) {
    responses = currentPlan.health;
  }
  if (!responses) {
    res.writeHead(404);
    res.end();
    return;
  }

  const attempt = received[url] ?? 0;
  received[url] = attempt + 1;
  const response = responseAt(responses, attempt);

  const headers: Record<string, string> = { 'content-type': 'text/plain' };
  for (const name of response.headerNames) {
    headers[name] = '1';
  }
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function runScript(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT_PATH, ...args], {
      cwd: options.cwd,
      env: { ...process.env, SMOKE_RETRY_DELAY: '0', TMPDIR: options.cwd, ...options.env },
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
      requests: {
        [ROOT.path]: received[ROOT.path] ?? 0,
        [HEALTH.path]: received[HEALTH.path] ?? 0,
      },
      originVerifySeen,
      leftovers: fs.readdirSync(workDir),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const successfulResponse: FakeResponse = {
  status: 200,
  headerNames: [...REQUIRED_HEADERS],
  body: HEALTH_BODY,
};

const failingResponse: FakeResponse = {
  status: 500,
  headerNames: [],
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

const headerNamesArb = fc
  .oneof(
    { weight: 3, arbitrary: fc.constant([...REQUIRED_HEADERS]) },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom(...REQUIRED_HEADERS)
        .map((dropped) => REQUIRED_HEADERS.filter((header) => header !== dropped)),
    },
    { weight: 1, arbitrary: fc.subarray([...REQUIRED_HEADERS]) },
  )
  .chain((names) =>
    fc.boolean().map((upperCase) => names.map((name) => (upperCase ? name.toUpperCase() : name))),
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

const responseArb: fc.Arbitrary<FakeResponse> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      status: fc.constant(200),
      headerNames: headerNamesArb,
      body: bodyArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ status: statusArb, headerNames: headerNamesArb, body: bodyArb }),
  },
);

const planArb: fc.Arbitrary<Plan> = fc.record({
  root: fc.array(responseArb, { minLength: 1, maxLength: 6 }),
  health: fc.array(responseArb, { minLength: 1, maxLength: 6 }),
});

describe('scripts/smoke-test.sh', () => {
  beforeAll(async () => {
    server = http.createServer(handleRequest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
    const run = await runPlan({
      root: [failingResponse, successfulResponse],
      health: [successfulResponse],
    });

    expect(run.exitCode).toBe(0);
    expect(run.requests).toEqual({ [ROOT.path]: 2, [HEALTH.path]: 1 });
    expect(run.stdout).toContain('OK: GET /');
    expect(run.stdout).toContain('OK: GET /api/v1/health');
  });

  it('fails with exactly 5 requests when the root check never passes', async () => {
    const run = await runPlan({ root: [failingResponse], health: [successfulResponse] });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('FAILED: GET / status 500');
    expect(run.requests).toEqual({ [ROOT.path]: MAX_ATTEMPTS, [HEALTH.path]: 0 });
  });

  it('names the missing header in the failed health check', async () => {
    const withoutFrameOptions: FakeResponse = {
      ...successfulResponse,
      headerNames: REQUIRED_HEADERS.filter((header) => header !== 'x-frame-options'),
    };
    const run = await runPlan({
      root: [successfulResponse],
      health: [withoutFrameOptions],
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('FAILED: GET /api/v1/health missing header x-frame-options');
    expect(run.requests).toEqual({ [ROOT.path]: 1, [HEALTH.path]: MAX_ATTEMPTS });
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
