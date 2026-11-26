/**
 * @jest-environment node
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const webRoot = path.resolve(__dirname, '..', '..');
const viteBin = path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');

// Public values. The payment public key placeholder must not start with `prv_`.
const PUBLIC_ENV = {
  VITE_API_BASE: '/api/v1',
  VITE_PAYMENT_API_URL: 'https://payment.example.test',
  VITE_PAYMENT_PUBLIC_KEY: 'pub_test_fake',
} as const;

// Non-VITE values standing in for the SSM secrets and their parameter names. Vite must never
// expose them, so none of them may appear in the emitted files.
const SECRET_FIXTURES = [
  'prv_fixture_secret_value',
  'fixture-secret-param',
  'fixture-integrity-value',
  'fixture-events-value',
  'fixture-origin-value',
] as const;

// Text rendered by the placeholder page. It proves the scan reads the application code.
const APP_MARKER = 'Tienda de productos';

// Vite default asset name: `assets/<name>-<8 char content hash>.<ext>`.
const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

// Environment for the child process. Only the variables the build needs are passed. The developer's
// shell, local `.env` files and any other `process.env` entries are not inherited.
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', ...PUBLIC_ENV };
  if (process.env.PATH !== undefined) {
    env.PATH = process.env.PATH;
  }
  if (process.env.HOME !== undefined) {
    env.HOME = process.env.HOME;
  }
  return {
    ...env,
    PAYMENT_PRIVATE_KEY: SECRET_FIXTURES[0],
    PAYMENT_PRIVATE_KEY_PARAM: SECRET_FIXTURES[1],
    PAYMENT_INTEGRITY_SECRET: SECRET_FIXTURES[2],
    PAYMENT_EVENTS_SECRET: SECRET_FIXTURES[3],
    ORIGIN_VERIFY_SECRET: SECRET_FIXTURES[4],
  };
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

describe('Feature: platform-foundation, Property 11: Web production bundle contains no secret material', () => {
  let tempDir: string;
  let outDir: string;
  let emittedFiles: string[];

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'web-bundle-'));
    outDir = path.join(tempDir, 'dist');
    await execFileAsync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: webRoot,
      env: buildEnv(),
      timeout: 170_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    emittedFiles = listFiles(outDir);
  }, 180_000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits at least one file, including the entry HTML', () => {
    expect(emittedFiles.map((file) => path.basename(file))).toContain('index.html');
  });

  it('does not contain the payment private key prefix in any emitted file', () => {
    const offenders = emittedFiles.filter((file) => readFileSync(file).includes('prv_'));
    expect(offenders).toEqual([]);
  });

  it.each(SECRET_FIXTURES)(
    'does not contain the secret fixture value %s in any emitted file',
    (secret) => {
      const offenders = emittedFiles.filter((file) => readFileSync(file).includes(secret));
      expect(offenders).toEqual([]);
    },
  );

  it('contains the application code, so the scan covers the real bundle', () => {
    const scripts = emittedFiles.filter((file) => file.endsWith('.js'));
    expect(scripts.some((file) => readFileSync(file, 'utf8').includes(APP_MARKER))).toBe(true);
  });

  it('names every emitted asset under assets/ with a content hash', () => {
    const assets = emittedFiles
      .filter((file) => path.relative(outDir, file).startsWith(`assets${path.sep}`))
      .filter((file) => /\.(?:js|css)$/.test(file))
      .map((file) => path.basename(file));
    expect(assets.length).toBeGreaterThan(0);
    for (const name of assets) {
      expect(name).toMatch(HASHED_ASSET);
    }
  });
});
