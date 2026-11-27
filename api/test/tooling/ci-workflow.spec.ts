import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const CI_WORKFLOW_PATH = path.resolve(__dirname, '../../../.github/workflows/ci.yml');
const NODE_VERSION = '22';

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadWorkflow(): Mapping {
  const parsed: unknown = parse(fs.readFileSync(CI_WORKFLOW_PATH, 'utf8'));
  if (!isMapping(parsed)) {
    throw new Error('ci.yml must parse to a mapping');
  }
  return parsed;
}

function getJob(workflow: Mapping, jobName: string): Mapping {
  const jobs: unknown = workflow.jobs;
  if (!isMapping(jobs) || !isMapping(jobs[jobName])) {
    throw new Error(`job "${jobName}" is missing from ci.yml`);
  }
  return jobs[jobName];
}

function getSteps(job: Mapping): Mapping[] {
  const steps: unknown = job.steps;
  return Array.isArray(steps) ? steps.filter(isMapping) : [];
}

function getWith(step: Mapping): Mapping {
  return isMapping(step.with) ? step.with : {};
}

function runLines(step: Mapping): string[] {
  return typeof step.run === 'string' ? step.run.split('\n').map((line) => line.trim()) : [];
}

function findRunStep(steps: Mapping[], command: string): Mapping | undefined {
  return steps.find((step) => runLines(step).includes(command));
}

function findUsesStep(steps: Mapping[], actionPrefix: string): Mapping | undefined {
  return steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith(actionPrefix));
}

function findCheckoutStep(steps: Mapping[]): Mapping | undefined {
  return findUsesStep(steps, 'actions/checkout@');
}

function findSetupNodeStep(steps: Mapping[]): Mapping | undefined {
  return findUsesStep(steps, 'actions/setup-node@');
}

const WORKSPACE_COMMANDS: readonly { readonly name: string; readonly run: string }[] = [
  { name: 'lint', run: 'npm run lint' },
  { name: 'typecheck', run: 'npx tsc --noEmit' },
  { name: 'tests with coverage', run: 'npm test -- --coverage' },
  { name: 'build', run: 'npm run build' },
];

describe('ci.yml workflow structure', () => {
  let workflow: Mapping;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  describe('triggers (Requirement 5.1)', () => {
    it('runs on pull_request', () => {
      const triggers = workflow.on;
      expect(isMapping(triggers) && 'pull_request' in triggers).toBe(true);
    });

    it('runs on push to master only', () => {
      const triggers: unknown = workflow.on;
      expect(isMapping(triggers) && isMapping(triggers.push)).toBe(true);
      const push = isMapping(workflow.on) && isMapping(workflow.on.push) ? workflow.on.push : {};
      expect(push.branches).toEqual(['master']);
    });
  });

  describe('permissions (Requirement 5.8)', () => {
    it('grants the workflow only contents: read', () => {
      expect(workflow.permissions).toEqual({ contents: 'read' });
    });
  });

  describe('Node.js and npm cache (Requirements 5.2, 5.7)', () => {
    it.each(['api', 'web'])('%s job sets up Node 22 with npm cache', (jobName) => {
      const steps = getSteps(getJob(workflow, jobName));
      const setupNode = findSetupNodeStep(steps);

      expect(setupNode).toBeDefined();
      const withInputs = getWith(setupNode ?? {});
      expect(withInputs['node-version']).toBe(NODE_VERSION);
      expect(withInputs.cache).toBe('npm');
      expect(withInputs['cache-dependency-path']).toBe(`${jobName}/package-lock.json`);
    });

    it('every setup-node step in the workflow uses Node 22', () => {
      const setupNodeSteps = Object.values(workflow.jobs as Mapping)
        .filter(isMapping)
        .flatMap(getSteps)
        .filter(
          (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@'),
        );

      expect(setupNodeSteps.length).toBeGreaterThan(0);
      for (const step of setupNodeSteps) {
        expect(getWith(step)['node-version']).toBe(NODE_VERSION);
      }
    });
  });

  describe('api job (Requirements 5.2, 5.3)', () => {
    const steps = (): Mapping[] => getSteps(getJob(workflow, 'api'));

    it.each(WORKSPACE_COMMANDS)('runs $name in api/', ({ run }) => {
      const step = findRunStep(steps(), run);
      expect(step).toBeDefined();
      expect(step?.['working-directory']).toBe('api');
    });

    it('installs dependencies with npm ci in api/', () => {
      const step = findRunStep(steps(), 'npm ci');
      expect(step?.['working-directory']).toBe('api');
    });

    it('runs the dependency-cruiser check in api/', () => {
      const step = findRunStep(steps(), 'npm run depcruise');
      expect(step?.['working-directory']).toBe('api');
    });
    describe('docs/openapi.json currency check (Requirement 18.6)', () => {
      const REGENERATE = 'npm run openapi';
      const DIFF_CHECK = 'git diff --exit-code -- ../docs/openapi.json';

      it('regenerates the OpenAPI document in api/', () => {
        const step = findRunStep(steps(), REGENERATE);
        expect(step?.['working-directory']).toBe('api');
      });
      it('fails when the regenerated document differs from the committed file', () => {
        const step = findRunStep(steps(), DIFF_CHECK);
        expect(step?.['working-directory']).toBe('api');
      });
      it('runs regeneration and the diff check after the tests with coverage', () => {
        const all = steps();
        const testIndex = all.indexOf(findRunStep(all, 'npm test -- --coverage') ?? {});
        const regenerateIndex = all.indexOf(findRunStep(all, REGENERATE) ?? {});
        const diffIndex = all.indexOf(findRunStep(all, DIFF_CHECK) ?? {});
        expect(testIndex).toBeGreaterThanOrEqual(0);
        expect(regenerateIndex).toBeGreaterThan(testIndex);
        expect(diffIndex).toBeGreaterThan(regenerateIndex);
      });
    });
  });

  describe('web job (Requirement 5.2)', () => {
    const steps = (): Mapping[] => getSteps(getJob(workflow, 'web'));

    it.each(WORKSPACE_COMMANDS)('runs $name in web/', ({ run }) => {
      const step = findRunStep(steps(), run);
      expect(step).toBeDefined();
      expect(step?.['working-directory']).toBe('web');
    });

    it('installs dependencies with npm ci in web/', () => {
      const step = findRunStep(steps(), 'npm ci');
      expect(step?.['working-directory']).toBe('web');
    });

    it('does not run dependency-cruiser', () => {
      const depcruiseSteps = steps().filter((step) =>
        runLines(step).some((line) => line.includes('depcruise')),
      );
      expect(depcruiseSteps).toHaveLength(0);
    });
  });

  describe('repo-checks job (Requirements 5.4, 5.5, 6.2, 6.6)', () => {
    const steps = (): Mapping[] => getSteps(getJob(workflow, 'repo-checks'));

    it('checks out the full history with fetch-depth 0', () => {
      const checkout = findCheckoutStep(steps());
      expect(checkout).toBeDefined();
      expect(getWith(checkout ?? {})['fetch-depth']).toBe(0);
    });

    it('runs gitleaks over the repository with --redact', () => {
      const gitleaksStep = steps().find((step) =>
        runLines(step).some((line) => line.startsWith('./gitleaks detect')),
      );
      expect(gitleaksStep).toBeDefined();
      const command = runLines(gitleaksStep ?? {}).join('\n');
      expect(command).toContain('--source .');
      expect(command).toContain('--redact');
    });

    it('runs the forbidden words check', () => {
      const forbiddenWordsStep = steps().find((step) =>
        runLines(step).some((line) => line.includes('scripts/check-forbidden-words.sh')),
      );
      expect(forbiddenWordsStep).toBeDefined();
    });
  });

  describe('no cloud credentials or deploy steps (Requirement 5.9 guard)', () => {
    it('grants no id-token permission at any level', () => {
      const permissions: unknown = workflow.permissions;
      expect(isMapping(permissions) && 'id-token' in permissions).toBe(false);
    });
    it('grants no id-token permission at job level', () => {
      const jobs = Object.values(workflow.jobs as Mapping).filter(isMapping);
      for (const job of jobs) {
        const permissions: unknown = job.permissions;
        expect(isMapping(permissions) && 'id-token' in permissions).toBe(false);
      }
    });
    it('uses no AWS credentials action or key variables in any step', () => {
      const text = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      expect(text).not.toMatch(/aws-actions\/configure-aws-credentials/);
      expect(text).not.toMatch(/AWS_ACCESS_KEY_ID/);
      expect(text).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
    });
  });
});
