import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import jestConfig from '../../jest.config';

// Feature: platform-foundation, Property 9: Coverage gate fails below threshold
// Validates: Requirements 3.3

const apiRoot = path.resolve(__dirname, '../..');
const JEST_BIN = path.join(apiRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const TS_JEST_PATH = require.resolve('ts-jest', { paths: [apiRoot] });
const TEST_TIMEOUT_MS = 120_000;

const SOURCE = `export function subtotal(unitInCents: number, quantity: number): number {
  return unitInCents * quantity;
}

export function total(subtotalInCents: number, feeInCents: number): number {
  return subtotalInCents + feeInCents;
}

export function label(amountInCents: number): string {
  if (amountInCents > 0) {
    return 'paid';
  }
  return 'free';
}
`;

// Covers only one of the three functions, so function coverage stays well below 80%.
const PARTIAL_TEST = `import { subtotal } from '../src/pricing';

describe('pricing', () => {
  it('multiplies unit price by quantity', () => {
    expect(subtotal(120000, 2)).toBe(240000);
  });
});
`;

// Covers every function and both branches of label().
const FULL_TEST = `import { label, subtotal, total } from '../src/pricing';

describe('pricing', () => {
  it('multiplies unit price by quantity', () => {
    expect(subtotal(120000, 2)).toBe(240000);
  });

  it('adds fees to the subtotal', () => {
    expect(total(240000, 11000)).toBe(251000);
  });

  it('labels positive and zero amounts', () => {
    expect(label(1)).toBe('paid');
    expect(label(0)).toBe('free');
  });
});
`;

const tempRoots: string[] = [];

/**
 * Builds a throwaway Jest project in the OS temp dir. The threshold block is the real one
 * exported by api/jest.config.ts, so the gate under test is the production configuration.
 */
function createFixture(testSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gate-'));
  tempRoots.push(root);

  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src', 'pricing.ts'), SOURCE);
  fs.writeFileSync(path.join(root, 'test', 'pricing.spec.ts'), testSource);

  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'commonjs',
        esModuleInterop: true,
        types: ['jest', 'node'],
        typeRoots: [path.join(apiRoot, 'node_modules', '@types')],
      },
      include: ['src/**/*.ts', 'test/**/*.ts'],
    }),
  );

  const jestProjectConfig = {
    rootDir: root,
    testEnvironment: 'node',
    transform: {
      '^.+\\.ts$': [TS_JEST_PATH, { tsconfig: path.join(root, 'tsconfig.json') }],
    },
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
    coverageThreshold: jestConfig.coverageThreshold,
  };
  fs.writeFileSync(path.join(root, 'jest.config.json'), JSON.stringify(jestProjectConfig));

  return root;
}

function runJestWithCoverage(root: string): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [JEST_BIN, '--config', path.join(root, 'jest.config.json'), '--coverage', '--ci'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('API coverage gate (Property 9)', () => {
  it(
    'exits non-zero when coverage is below the 80% threshold',
    () => {
      const root = createFixture(PARTIAL_TEST);
      const { status, output } = runJestWithCoverage(root);

      expect(status).not.toBe(0);
      expect(output).toMatch(/does not meet "global" threshold/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits zero when every file is fully covered',
    () => {
      const root = createFixture(FULL_TEST);
      const { status, output } = runJestWithCoverage(root);

      expect(status).toBe(0);
      expect(output).not.toMatch(/does not meet "global" threshold/);
    },
    TEST_TIMEOUT_MS,
  );
});
