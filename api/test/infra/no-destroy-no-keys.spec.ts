import * as fs from 'fs';
import * as path from 'path';
import fc from 'fast-check';
import { parse } from 'yaml';
import {
  DEPLOY_ONLY_RULES,
  NO_DESTROY_NO_KEYS_RULES,
  WorkflowRule,
  scanWorkflow,
} from '../tooling/helpers/workflow-scanner';

// Validates: Requirements 15.5, 15.6, 15.7, 20.10, 21.5, 21.13
const repoRoot = path.resolve(__dirname, '../../..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const scriptsDir = path.join(repoRoot, 'scripts');
const CI_PATH = path.join(workflowsDir, 'ci.yml');
const DEPLOY_PATH = path.join(workflowsDir, 'deploy.yml');
const NUM_RUNS = 100;

const ALL_RULES: readonly WorkflowRule[] = [...NO_DESTROY_NO_KEYS_RULES, ...DEPLOY_ONLY_RULES];

// Letters and symbols that cannot form a forbidden token on their own. Each generated line is
// still checked against every rule, so a chance combination never reaches the clean-text property.
const NOISE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789 :-_./{}$'.split('');
const SAFE_WORDS = [
  'name',
  'on',
  'jobs',
  'run',
  'uses',
  'with',
  'terraform',
  'init',
  'plan',
  'validate',
  'secrets',
  'AKIA12',
  'AWS',
  'region',
  'us-east-1',
  'destroyed',
  'checkout',
  'true',
  'false',
];

interface Injection {
  readonly ruleId: string;
  readonly tokenArb: fc.Arbitrary<string>;
  // Builds a line that places the token where it matters, e.g. as a key or inside a command.
  readonly build: (token: string) => string;
}

// Returns `text` with each character in upper case where the matching flag is true.
function applyCase(text: string, upper: readonly boolean[]): string {
  return text
    .split('')
    .map((ch, i) => (upper[i] ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
}

function caseVariant(text: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: text.length, maxLength: text.length })
    .map((upper) => applyCase(text, upper));
}

const ACCESS_KEY_SUFFIX_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const INJECTIONS: readonly Injection[] = [
  {
    ruleId: 'terraform-destroy',
    tokenArb: caseVariant('terraform destroy'),
    build: (t) => `run: ${t} -auto-approve`,
  },
  {
    ruleId: 'destroy-flag',
    tokenArb: caseVariant('-destroy'),
    build: (t) => `run: terraform plan ${t}`,
  },
  {
    ruleId: 'aws-access-key-id-input',
    tokenArb: caseVariant('aws-access-key-id'),
    build: (t) => `${t}: \${{ vars.KEY }}`,
  },
  {
    ruleId: 'aws-access-key-id-variable',
    tokenArb: caseVariant('AWS_ACCESS_KEY_ID'),
    build: (t) => `env: ${t}: value`,
  },
  {
    ruleId: 'aws-secret-access-key',
    tokenArb: caseVariant('AWS_SECRET_ACCESS_KEY'),
    build: (t) => `run: echo $${t}`,
  },
  {
    ruleId: 'long-lived-access-key',
    tokenArb: fc
      .array(fc.constantFrom(...ACCESS_KEY_SUFFIX_CHARS), { minLength: 16, maxLength: 16 })
      .map((chars) => `AKIA${chars.join('')}`),
    build: (t) => `key: ${t}`,
  },
  {
    ruleId: 'secrets-expression',
    tokenArb: caseVariant('secrets.'),
    build: (t) => `token: \${{ ${t}DEPLOY_KEY }}`,
  },
];

function isClean(line: string): boolean {
  return scanWorkflow(line, ALL_RULES).length === 0;
}

const cleanLineArb = fc
  .tuple(
    fc.integer({ min: 0, max: 8 }),
    fc.array(fc.constantFrom(...SAFE_WORDS), { minLength: 0, maxLength: 4 }),
    fc.constantFrom('', ':', ' - ', ' ${{ matrix.node }}'),
  )
  .map(([indent, words, suffix]) => `${' '.repeat(indent)}${words.join(' ')}${suffix}`)
  .filter(isClean);

const noiseLineArb = fc
  .array(fc.constantFrom(...NOISE_CHARS), { minLength: 0, maxLength: 40 })
  .map((chars) => chars.join(''))
  .filter(isClean);

const cleanTextArb = fc
  .array(fc.oneof(cleanLineArb, noiseLineArb), { minLength: 1, maxLength: 12 })
  .map((lines) => lines.join('\n'));

interface InjectionInput {
  readonly before: string[];
  readonly after: string[];
  readonly token: string;
  readonly indent: number;
}

function injectionArb(sample: Injection): fc.Arbitrary<InjectionInput> {
  return fc.record({
    before: fc.array(cleanLineArb, { minLength: 0, maxLength: 6 }),
    after: fc.array(cleanLineArb, { minLength: 0, maxLength: 6 }),
    token: sample.tokenArb,
    indent: fc.integer({ min: 0, max: 8 }),
  });
}

// Joins the clean lines around one injected line. Returns the text and the injected line number.
function buildText(
  sample: Injection,
  input: InjectionInput,
): { text: string; injectedLine: number } {
  const injected = `${' '.repeat(input.indent)}${sample.build(input.token)}`;
  const lines = [...input.before, injected, ...input.after];
  return { text: lines.join('\n'), injectedLine: input.before.length + 1 };
}

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name));
}

function readYaml(file: string): Record<string, unknown> {
  const doc: unknown = parse(fs.readFileSync(file, 'utf8'));
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${path.basename(file)} is not a mapping`);
  }
  return doc as Record<string, unknown>;
}

interface WorkflowStep {
  readonly uses?: unknown;
  readonly with?: unknown;
}

function stepsOf(doc: Record<string, unknown>): WorkflowStep[] {
  const jobs = (doc.jobs ?? {}) as Record<string, { steps?: WorkflowStep[] }>;
  return Object.values(jobs).flatMap((job) => job.steps ?? []);
}

describe('Feature: platform-foundation, Property 13: workflows contain no destroy and no long-lived AWS credentials', () => {
  describe('scanner detects every forbidden token', () => {
    for (const sample of INJECTIONS) {
      it(`flags ${sample.ruleId} at the injected line`, () => {
        fc.assert(
          fc.property(injectionArb(sample), (input) => {
            const { text, injectedLine } = buildText(sample, input);
            const violations = scanWorkflow(text, ALL_RULES);
            expect(violations).toContainEqual({ rule: sample.ruleId, line: injectedLine });
          }),
          { numRuns: NUM_RUNS },
        );
      });
    }
  });

  it('passes random clean text', () => {
    fc.assert(
      fc.property(cleanTextArb, (text) => {
        expect(scanWorkflow(text, ALL_RULES)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('applies the secrets rule only to deploy.yml, so ci.yml and scripts may keep the shared rules only', () => {
    const line = 'token: ${{ secrets.DEPLOY_KEY }}';
    expect(scanWorkflow(line, NO_DESTROY_NO_KEYS_RULES)).toEqual([]);
    expect(scanWorkflow(line, DEPLOY_ONLY_RULES)).toEqual([
      { rule: 'secrets-expression', line: 1 },
    ]);
  });

  it('reports zero violations for every workflow and every script', () => {
    const files = [...listFiles(workflowsDir), ...listFiles(scriptsDir)];
    expect(files.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(['ci.yml', 'deploy.yml', 'smoke-test.sh', 'check-forbidden-words.sh']),
    );
    const violations: Record<string, unknown[]> = {};
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const rules = file === DEPLOY_PATH ? ALL_RULES : NO_DESTROY_NO_KEYS_RULES;
      const found = scanWorkflow(text, rules);
      if (found.length > 0) {
        violations[path.relative(repoRoot, file)] = found;
      }
    }
    expect(violations).toEqual({});
  });

  it('uses the OIDC role input of configure-aws-credentials in deploy.yml and no access key inputs', () => {
    // The spec text says `role-arn`, but the input of aws-actions/configure-aws-credentials
    // is `role-to-assume`, so the assertion uses that name.
    const steps = stepsOf(readYaml(DEPLOY_PATH)).filter(
      (step) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('aws-actions/configure-aws-credentials@'),
    );
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(String(step.uses)).toMatch(/@[0-9a-f]{40}\b/);
      const inputs = (step.with ?? {}) as Record<string, unknown>;
      expect(inputs['role-to-assume']).toBe('${{ vars.AWS_ROLE_ARN }}');
      expect(inputs).not.toHaveProperty('aws-access-key-id');
      expect(inputs).not.toHaveProperty('aws-secret-access-key');
    }
  });

  it('contains no terraform apply string in ci.yml or in scripts/', () => {
    const files = [CI_PATH, ...listFiles(scriptsDir)];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect({ file: path.basename(file), applies: /terraform\s+apply/i.test(text) }).toEqual({
        file: path.basename(file),
        applies: false,
      });
    }
  });
});
