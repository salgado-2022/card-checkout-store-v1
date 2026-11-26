import * as fs from 'fs';
import * as path from 'path';
import fc from 'fast-check';
import { parse } from 'yaml';
import { CI_FORBIDDEN_RULES, scanWorkflow } from './helpers/workflow-scanner';

// Validates: Requirements 5.8, 5.9, 5.10
const repoRoot = path.resolve(__dirname, '../../..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const CI_PATH = path.join(workflowsDir, 'ci.yml');
const DEPLOY_PATH = path.join(workflowsDir, 'deploy.yml');
const NUM_RUNS = 100;

// Words that cannot form a forbidden token on their own. Clean lines are still filtered
// through the scanner, so a chance combination of words can never produce a false positive.
const SAFE_WORDS = [
  'name',
  'on',
  'jobs',
  'steps',
  'run',
  'uses',
  'with',
  'node-version',
  'checkout',
  'npm',
  'test',
  'lint',
  'build',
  'contents',
  'read',
  'permissions',
  'cache',
  'true',
  'false',
  'foo',
  'bar',
  'ubuntu-latest',
  'master',
  'push',
  'pull',
  'request',
  'matrix',
];
const NOISE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789 :-_./{}$'.split('');

interface InjectionSample {
  readonly ruleId: string;
  readonly token: string;
  // Builds a YAML-like line that contains the token in the position where it matters.
  readonly build: (token: string) => string;
}

const INJECTIONS: readonly InjectionSample[] = [
  {
    ruleId: 'secrets-expression',
    token: 'secrets.',
    build: (t) => `token: \${{ ${t}DEPLOY_KEY }}`,
  },
  {
    ruleId: 'aws-action',
    token: 'aws-actions/',
    build: (t) => `uses: ${t}configure-aws-credentials@v4`,
  },
  { ruleId: 'id-token-permission', token: 'id-token', build: (t) => `${t}: write` },
  { ruleId: 'aws-variable', token: 'AWS_', build: (t) => `run: echo ${t}REGION` },
  { ruleId: 'terraform-command', token: 'terraform', build: (t) => `run: ${t} plan` },
  { ruleId: 'environment-key', token: 'environment:', build: (t) => `    ${t} production` },
];

function isClean(line: string): boolean {
  return scanWorkflow(line, CI_FORBIDDEN_RULES).length === 0;
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

const anyCleanLineArb = fc.oneof(cleanLineArb, noiseLineArb);

// Random YAML-like text that contains no forbidden token.
const cleanTextArb = fc
  .array(anyCleanLineArb, { minLength: 1, maxLength: 12 })
  .map((lines) => lines.join('\n'));

function applyCase(token: string, upper: readonly boolean[]): string {
  return token
    .split('')
    .map((ch, i) => (upper[i] ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
}

// Embeds one forbidden token (random letter case, random indentation) between clean lines.
function injectionArb(sample: InjectionSample) {
  return fc.record({
    before: fc.array(cleanLineArb, { minLength: 0, maxLength: 6 }),
    after: fc.array(cleanLineArb, { minLength: 0, maxLength: 6 }),
    upper: fc.array(fc.boolean(), {
      minLength: sample.token.length,
      maxLength: sample.token.length,
    }),
    indent: fc.integer({ min: 0, max: 8 }),
  });
}

function buildText(
  sample: InjectionSample,
  input: { before: string[]; after: string[]; upper: boolean[]; indent: number },
): { text: string; injectedLine: number } {
  const token = applyCase(sample.token, input.upper);
  const injected = `${' '.repeat(input.indent)}${sample.build(token)}`;
  const lines = [...input.before, injected, ...input.after];
  return { text: lines.join('\n'), injectedLine: input.before.length + 1 };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a mapping`);
  }
  return value as Record<string, unknown>;
}

function readYaml(file: string): Record<string, unknown> {
  return asRecord(parse(fs.readFileSync(file, 'utf8')), path.basename(file));
}

// Trigger names from the `on` key, which may be a string, a list or a mapping.
function triggerNames(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((item): item is string => typeof item === 'string');
  if (typeof on === 'object' && on !== null) return Object.keys(on);
  return [];
}

describe('Feature: platform-foundation, Property 14: ci.yml has no AWS, secret or deploy references', () => {
  describe('scanner detects every forbidden token', () => {
    for (const sample of INJECTIONS) {
      it(`flags "${sample.token}" as ${sample.ruleId} at the injected line`, () => {
        fc.assert(
          fc.property(injectionArb(sample), (input) => {
            const { text, injectedLine } = buildText(sample, input);
            const violations = scanWorkflow(text, CI_FORBIDDEN_RULES);
            expect(violations).toContainEqual({ rule: sample.ruleId, line: injectedLine });
          }),
          { numRuns: NUM_RUNS },
        );
      });
    }
  });

  it('passes random clean YAML-like text', () => {
    fc.assert(
      fc.property(cleanTextArb, (text) => {
        expect(scanWorkflow(text, CI_FORBIDDEN_RULES)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('reports zero violations for the real ci.yml', () => {
    const text = fs.readFileSync(CI_PATH, 'utf8');
    expect(scanWorkflow(text, CI_FORBIDDEN_RULES)).toEqual([]);
  });

  it('declares contents: read as the only top-level and job-level permission', () => {
    const doc = readYaml(CI_PATH);
    expect(doc.permissions).toEqual({ contents: 'read' });
    const jobs = asRecord(doc.jobs, 'jobs');
    for (const [name, job] of Object.entries(jobs)) {
      const jobRecord = asRecord(job, `job ${name}`);
      if ('permissions' in jobRecord) {
        expect(jobRecord.permissions).toEqual({ contents: 'read' });
      }
    }
  });

  const describeDeploy = fs.existsSync(DEPLOY_PATH) ? it : it.skip;
  describeDeploy('deploy.yml has no pull_request trigger', () => {
    const triggers = triggerNames(readYaml(DEPLOY_PATH).on);
    expect(triggers).not.toContain('pull_request');
    expect(triggers).not.toContain('pull_request_target');
  });
});
