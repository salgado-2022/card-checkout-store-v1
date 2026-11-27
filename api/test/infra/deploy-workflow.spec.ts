import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

// Property 15: deploy.yml job order, gating and permissions.
// Each assertion takes the parsed workflow so the mutation table can reuse them.
const DEPLOY_WORKFLOW_PATH = path.resolve(__dirname, '../../../.github/workflows/deploy.yml');

const CHAIN = ['plan', 'apply', 'deploy-api', 'deploy-web', 'smoke-test'];
const PRODUCTION_JOBS = ['apply', 'deploy-api', 'deploy-web'];
const DEPLOY_SHA_REF = '${{ env.DEPLOY_SHA }}';
const CHECKOUT_PREFIX = 'actions/checkout@';
const AWS_CREDENTIALS_PREFIX = 'aws-actions/configure-aws-credentials@';
const ARTIFACT_PREFIXES = ['actions/upload-artifact@', 'actions/download-artifact@'];
const ALLOWED_PERMISSIONS: Readonly<Record<string, string>> = {
  'id-token': 'write',
  contents: 'read',
};
const PROVIDERS_PATH = path.resolve(__dirname, '../../../infra/providers.tf');
const SETUP_TERRAFORM_PREFIX = 'hashicorp/setup-terraform@';
const TERRAFORM_JOBS = ['plan', 'apply'];
const BUILD_THEN_DEPLOY_JOBS = ['deploy-api', 'deploy-web'];
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const AWS_CLI_COMMAND = /(^|[\s;&|(])aws\s/;
const PLAN_GATE =
  "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master') || " +
  "(github.event.workflow_run.conclusion == 'success' && " +
  "github.event.workflow_run.event == 'push' && " +
  'github.event.workflow_run.head_repository.full_name == github.repository)';
const PLAN_GATE_FRAGMENTS = [
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'",
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
];
const PLAN_STEP_ORDER = [
  /terraform fmt -check/,
  /terraform init\b/,
  /terraform validate\b/,
  /terraform plan\b/,
];
const TF_VARS_FROM_REPOSITORY_VARS = [
  'TF_VAR_payment_api_url',
  'TF_VAR_payment_public_key',
  'TF_VAR_budget_notification_email',
];
const VARS_REFERENCE = /^\$\{\{\s*vars\.[A-Z_]+\s*\}\}$/;
const TERRAFORM_APPLY = /\bterraform apply\b/;
const TERRAFORM_PLAN_OUT_FILE = /\bterraform plan\b.*-out=tfplan$/;
const SYNC_IMMUTABLE =
  /aws s3 sync \S+ \S+ .*--cache-control "public, max-age=31536000, immutable"/;
const INDEX_NO_CACHE = /aws s3 cp \S*index\.html \S+ --cache-control "no-cache"/;
const CLOUDFRONT_INVALIDATION = /aws cloudfront create-invalidation\b/;
const LAMBDA_CODE_UPDATE = /aws lambda update-function-code\b/;
const SETUP_NODE_PREFIX = 'actions/setup-node@';
const WEB_SYNC_EXCLUDES_DOCS =
  /aws s3 sync web\/dist "s3:\/\/\$WEB_BUCKET_NAME" --delete --exclude index\.html --exclude "docs\/\*" --cache-control/;
const DOCS_BUILD = /npm ci && npm run docs:site/;
const DOCS_SYNC = /aws s3 sync docs\/site "s3:\/\/\$WEB_BUCKET_NAME\/docs" --delete/;
const OPENAPI_COPY =
  /aws s3 cp docs\/site\/openapi\.json "s3:\/\/\$WEB_BUCKET_NAME\/docs\/openapi\.json" --cache-control no-cache --content-type application\/json/;
const INVALIDATION_WITH_DOCS =
  /aws cloudfront create-invalidation --distribution-id "\$DISTRIBUTION_ID" --paths "\/\*" "\/docs\/\*"/;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asMapping(value: unknown, label: string): Mapping {
  if (!isMapping(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value;
}

// Joins folded and continued lines so fragments can be matched on one line.
function normalize(text: string): string {
  return text.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function loadDeployWorkflow(): Mapping {
  return asMapping(parse(fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8')), 'deploy.yml');
}

function jobsOf(workflow: Mapping): Record<string, Mapping> {
  const jobs = asMapping(workflow.jobs, 'jobs');
  return Object.fromEntries(
    Object.entries(jobs).map(([name, job]) => [name, asMapping(job, `job ${name}`)]),
  );
}

function getJob(workflow: Mapping, name: string): Mapping {
  const job = jobsOf(workflow)[name];
  if (job === undefined) {
    throw new Error(`job "${name}" is missing from deploy.yml`);
  }
  return job;
}

// Returns the job's own step objects. Mutations edit these objects in place.
function rawSteps(job: Mapping): Mapping[] {
  return job.steps as Mapping[];
}

function stepsOf(job: Mapping): Mapping[] {
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error('job steps must be a list');
  }
  return steps.map((step) => asMapping(step, 'step'));
}

function runOf(step: Mapping): string {
  return typeof step.run === 'string' ? normalize(step.run) : '';
}

function usesOf(step: Mapping): string {
  return typeof step.uses === 'string' ? step.uses : '';
}

function usesAction(step: Mapping, prefix: string): boolean {
  return usesOf(step).startsWith(prefix);
}

function withOf(step: Mapping): Mapping {
  return isMapping(step.with) ? step.with : {};
}

function callsAws(job: Mapping): boolean {
  return stepsOf(job).some((step) => usesAction(step, AWS_CREDENTIALS_PREFIX));
}

function needsOf(job: Mapping): string[] {
  const needs = job.needs;
  if (needs === undefined) {
    return [];
  }
  if (typeof needs === 'string') {
    return [needs];
  }
  return Array.isArray(needs) ? needs.map(String) : [];
}

function permissionsOf(workflow: Mapping, job: Mapping): Mapping {
  return asMapping(job.permissions ?? workflow.permissions, 'permissions');
}

function runsOf(workflow: Mapping, jobName: string): string {
  return stepsOf(getJob(workflow, jobName)).map(runOf).join('\n');
}

function assertTriggers(workflow: Mapping): void {
  const on = asMapping(workflow.on, 'on');
  expect(Object.keys(on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
  const workflowRun = asMapping(on.workflow_run, 'on.workflow_run');
  expect(workflowRun.workflows).toEqual(['ci']);
  expect(workflowRun.types).toEqual(['completed']);
  expect(workflowRun.branches).toEqual(['master']);
}

function assertPlanGate(workflow: Mapping): void {
  const condition = normalize(String(getJob(workflow, 'plan').if ?? ''));
  for (const fragment of PLAN_GATE_FRAGMENTS) {
    expect(condition).toContain(fragment);
  }
  expect(condition).toBe(PLAN_GATE);
}

function assertCheckoutsUseDeploySha(workflow: Mapping): void {
  for (const [jobName, job] of Object.entries(jobsOf(workflow))) {
    const checkouts = stepsOf(job).filter((step) => usesAction(step, CHECKOUT_PREFIX));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect({ job: jobName, ref: withOf(checkout).ref }).toEqual({
        job: jobName,
        ref: DEPLOY_SHA_REF,
      });
    }
  }
}

function assertPermissionsWithinAllowedSet(workflow: Mapping): void {
  const allowedEntries = (permissions: Mapping): [string, unknown][] =>
    Object.entries(permissions).filter(([key, value]) => ALLOWED_PERMISSIONS[key] !== value);
  expect(allowedEntries(asMapping(workflow.permissions, 'permissions'))).toEqual([]);
  for (const [jobName, job] of Object.entries(jobsOf(workflow))) {
    expect({ job: jobName, extra: allowedEntries(permissionsOf(workflow, job)) }).toEqual({
      job: jobName,
      extra: [],
    });
  }
}

function assertAwsJobsHaveOidcPermissions(workflow: Mapping): void {
  for (const [jobName, job] of Object.entries(jobsOf(workflow))) {
    if (callsAws(job)) {
      expect({ job: jobName, permissions: permissionsOf(workflow, job) }).toEqual({
        job: jobName,
        permissions: ALLOWED_PERMISSIONS,
      });
    }
  }
}

function assertNeedsChain(workflow: Mapping): void {
  const jobs = jobsOf(workflow);
  expect(Object.keys(jobs).sort()).toEqual([...CHAIN].sort());
  CHAIN.forEach((jobName, index) => {
    const needs = needsOf(jobs[jobName]);
    if (index === 0) {
      expect(needs).toEqual([]);
      return;
    }
    expect(needs).toContain(CHAIN[index - 1]);
    // Every dependency must be an earlier job in the chain, so the graph has no shortcuts.
    const isEarlierJob = (dependency: string): boolean =>
      CHAIN.indexOf(dependency) >= 0 && CHAIN.indexOf(dependency) < index;
    expect(needs.every(isEarlierJob)).toBe(true);
  });
}

function assertEnvironments(workflow: Mapping): void {
  for (const jobName of PRODUCTION_JOBS) {
    expect(getJob(workflow, jobName).environment).toBe('production');
  }
  expect(getJob(workflow, 'plan').environment).toBeUndefined();
}

function assertApplyUsesSavedPlan(workflow: Mapping): void {
  const jobsWithApply = Object.entries(jobsOf(workflow)).flatMap(([jobName, job]) =>
    stepsOf(job)
      .filter((step) => TERRAFORM_APPLY.test(runOf(step)))
      .map(() => jobName),
  );
  expect(jobsWithApply).toEqual(['apply']);

  const steps = stepsOf(getJob(workflow, 'apply'));
  const planIndex = steps.findIndex((step) => TERRAFORM_PLAN_OUT_FILE.test(runOf(step)));
  const applyIndex = steps.findIndex((step) => TERRAFORM_APPLY.test(runOf(step)));
  expect(planIndex).toBeGreaterThanOrEqual(0);
  expect(applyIndex).toBeGreaterThan(planIndex);
  expect(runOf(steps[applyIndex]).split(' ').at(-1)).toBe('tfplan');
}

function assertNoArtifactActions(workflow: Mapping): void {
  const artifactSteps = Object.entries(jobsOf(workflow)).flatMap(([jobName, job]) =>
    stepsOf(job)
      .filter((step) => ARTIFACT_PREFIXES.some((prefix) => usesAction(step, prefix)))
      .map((step) => ({ job: jobName, uses: usesOf(step) })),
  );
  expect(artifactSteps).toEqual([]);
}

function assertConcurrencyKeepsRunningDeploy(workflow: Mapping): void {
  const concurrency = asMapping(workflow.concurrency, 'concurrency');
  expect(typeof concurrency.group).toBe('string');
  expect(concurrency['cancel-in-progress']).toBe(false);
}

function assertPlanStepOrder(workflow: Mapping): void {
  const steps = stepsOf(getJob(workflow, 'plan'));
  const positions = PLAN_STEP_ORDER.map((pattern) =>
    steps.findIndex((step) => pattern.test(runOf(step))),
  );
  expect(positions).not.toContain(-1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

function assertInitUsesStateBucket(workflow: Mapping): void {
  const env = asMapping(workflow.env, 'env');
  expect(env.TF_STATE_BUCKET).toMatch(VARS_REFERENCE);
  for (const jobName of ['plan', 'apply']) {
    const initStep = stepsOf(getJob(workflow, jobName)).find((step) =>
      /terraform init\b/.test(runOf(step)),
    );
    expect(initStep).toBeDefined();
    expect(runOf(initStep ?? {})).toContain('-backend-config="bucket=$TF_STATE_BUCKET"');
  }
}

function assertTfVarsFromRepositoryVars(workflow: Mapping): void {
  const env = asMapping(workflow.env, 'env');
  for (const name of TF_VARS_FROM_REPOSITORY_VARS) {
    expect(env[name]).toMatch(VARS_REFERENCE);
  }
}

function assertWebCachePolicy(workflow: Mapping): void {
  const runs = runsOf(workflow, 'deploy-web');
  expect(runs).toMatch(SYNC_IMMUTABLE);
  expect(runs).toMatch(INDEX_NO_CACHE);
  expect(runs).toMatch(CLOUDFRONT_INVALIDATION);
}

function assertLambdaCodeUpdate(workflow: Mapping): void {
  expect(runsOf(workflow, 'deploy-api')).toMatch(LAMBDA_CODE_UPDATE);
}

function assertWebSyncExcludesDocs(workflow: Mapping): void {
  expect(runsOf(workflow, 'deploy-web')).toMatch(WEB_SYNC_EXCLUDES_DOCS);
}

function assertDocsSiteBuild(workflow: Mapping): void {
  const job = getJob(workflow, 'deploy-web');
  const setup = stepsOf(job).find((step) => usesAction(step, SETUP_NODE_PREFIX));
  expect(setup).toBeDefined();
  expect(withOf(setup ?? {})['node-version']).toBe('22');
  expect(String(withOf(setup ?? {})['cache-dependency-path'])).toContain('api/package-lock.json');

  const build = stepsOf(job).find((step) => DOCS_BUILD.test(runOf(step)));
  expect(build).toBeDefined();
  expect(build?.['working-directory']).toBe('api');
}

// Upload order: docs are built, credentials are loaded, the web and docs are synced, and
// CloudFront is invalidated last, after every upload.
function assertDocsPublishOrder(workflow: Mapping): void {
  const steps = stepsOf(getJob(workflow, 'deploy-web'));
  const indexWhere = (pattern: RegExp): number =>
    steps.findIndex((step) => pattern.test(runOf(step)));
  const positions = [
    indexWhere(DOCS_BUILD),
    steps.findIndex((step) => usesAction(step, AWS_CREDENTIALS_PREFIX)),
    indexWhere(WEB_SYNC_EXCLUDES_DOCS),
    indexWhere(DOCS_SYNC),
    indexWhere(OPENAPI_COPY),
    indexWhere(INVALIDATION_WITH_DOCS),
  ];
  expect(positions).not.toContain(-1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

function assertDocsSyncAndOpenApiCopy(workflow: Mapping): void {
  const runs = runsOf(workflow, 'deploy-web');
  expect(runs).toMatch(DOCS_SYNC);
  expect(runs).toMatch(OPENAPI_COPY);
}

function assertInvalidationCoversDocs(workflow: Mapping): void {
  expect(runsOf(workflow, 'deploy-web')).toMatch(INVALIDATION_WITH_DOCS);
}

function parseVersion(text: string): number[] {
  const parts = text.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`not a version: ${text}`);
  }
  return parts;
}
function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const index = a.findIndex((part, position) => part !== b[position]);
  return index === -1 ? 0 : a[index] - b[index];
}
// Supports the operators used in infra/providers.tf: >=, >, <=, <, = (comma separated).
function satisfies(version: string, constraints: string): boolean {
  return constraints.split(',').every((raw) => {
    const match = /^\s*(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)\s*$/.exec(raw);
    if (match === null) {
      throw new Error(`unsupported constraint: ${raw}`);
    }
    const order = compareVersions(version, match[2]);
    switch (match[1] ?? '=') {
      case '>=':
        return order >= 0;
      case '>':
        return order > 0;
      case '<=':
        return order <= 0;
      case '<':
        return order < 0;
      default:
        return order === 0;
    }
  });
}
function requiredTerraformVersion(): string {
  const match = /required_version\s*=\s*"([^"]+)"/.exec(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
  if (match === null) {
    throw new Error('required_version not found in infra/providers.tf');
  }
  return match[1];
}
function assertTerraformVersionPinned(workflow: Mapping): void {
  const required = requiredTerraformVersion();
  for (const jobName of TERRAFORM_JOBS) {
    const setups = stepsOf(getJob(workflow, jobName)).filter((step) =>
      usesAction(step, SETUP_TERRAFORM_PREFIX),
    );
    expect({ job: jobName, setups: setups.length }).toEqual({ job: jobName, setups: 1 });
    const version = withOf(setups[0]).terraform_version;
    expect({ job: jobName, exact: EXACT_SEMVER.test(String(version)) }).toEqual({
      job: jobName,
      exact: true,
    });
    expect({ job: jobName, allowed: satisfies(String(version), required) }).toEqual({
      job: jobName,
      allowed: true,
    });
  }
  // Every setup-terraform step in the workflow is covered by the check above.
  const allSetups = Object.values(jobsOf(workflow)).flatMap((job) =>
    stepsOf(job).filter((step) => usesAction(step, SETUP_TERRAFORM_PREFIX)),
  );
  expect(allSetups).toHaveLength(TERRAFORM_JOBS.length);
}
function assertCredentialsLoadedAfterBuild(workflow: Mapping): void {
  for (const jobName of BUILD_THEN_DEPLOY_JOBS) {
    const steps = stepsOf(getJob(workflow, jobName));
    const credentialSteps = steps.filter((step) => usesAction(step, AWS_CREDENTIALS_PREFIX));
    expect({ job: jobName, credentials: credentialSteps.length }).toEqual({
      job: jobName,
      credentials: 1,
    });
    const credentialsIndex = steps.indexOf(credentialSteps[0]);
    const buildIndex = steps.findIndex((step) => /\bnpm run build\b/.test(runOf(step)));
    const installIndex = steps.findIndex((step) => /\bnpm ci\b/.test(runOf(step)));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect({ job: jobName, afterInstall: credentialsIndex > installIndex }).toEqual({
      job: jobName,
      afterInstall: true,
    });
    expect({ job: jobName, afterBuild: credentialsIndex > buildIndex }).toEqual({
      job: jobName,
      afterBuild: true,
    });
    // Nothing that runs before the credentials step may call the AWS CLI.
    const earlyAwsCalls = steps
      .slice(0, credentialsIndex)
      .filter((step) => AWS_CLI_COMMAND.test(runOf(step)))
      .map(runOf);
    expect({ job: jobName, earlyAwsCalls }).toEqual({ job: jobName, earlyAwsCalls: [] });
  }
}
interface Assertion {
  readonly name: string;
  readonly check: (workflow: Mapping) => void;
}

const ASSERTIONS: readonly Assertion[] = [
  {
    name: 'triggers are workflow_run on ci/master and workflow_dispatch only',
    check: assertTriggers,
  },
  {
    name: 'plan runs only after a successful push CI run in this repository or on dispatch from master',
    check: assertPlanGate,
  },
  {
    name: 'every checkout pins DEPLOY_SHA',
    check: assertCheckoutsUseDeploySha,
  },
  {
    name: 'every job permission is within id-token: write and contents: read',
    check: assertPermissionsWithinAllowedSet,
  },
  {
    name: 'every job that calls AWS has id-token: write and contents: read',
    check: assertAwsJobsHaveOidcPermissions,
  },
  {
    name: 'jobs form the chain plan -> apply -> deploy-api -> deploy-web -> smoke-test',
    check: assertNeedsChain,
  },
  {
    name: 'apply, deploy-api and deploy-web use the production environment; plan has none',
    check: assertEnvironments,
  },
  {
    name: 'terraform apply runs only in apply, after the saved plan, with tfplan',
    check: assertApplyUsesSavedPlan,
  },
  {
    name: 'no job uploads or downloads artifacts',
    check: assertNoArtifactActions,
  },
  {
    name: 'concurrency never cancels a running deploy',
    check: assertConcurrencyKeepsRunningDeploy,
  },
  {
    name: 'plan runs fmt -check, init, validate and plan in that order',
    check: assertPlanStepOrder,
  },
  {
    name: 'init in plan and apply receives the bucket from TF_STATE_BUCKET',
    check: assertInitUsesStateBucket,
  },
  {
    name: 'payment and budget TF_VAR values come from repository vars',
    check: assertTfVarsFromRepositoryVars,
  },
  {
    name: 'web sync caches assets immutably, index.html is no-cache, CloudFront is invalidated',
    check: assertWebCachePolicy,
  },
  {
    name: 'deploy-api runs update-function-code',
    check: assertLambdaCodeUpdate,
  },
  {
    name: 'web sync excludes docs/* so --delete never removes the published docs',
    check: assertWebSyncExcludesDocs,
  },
  {
    name: 'API docs are built with npm ci and npm run docs:site in api/ on Node 22',
    check: assertDocsSiteBuild,
  },
  {
    name: 'docs sync uses --delete and openapi.json is copied with no-cache and JSON content type',
    check: assertDocsSyncAndOpenApiCopy,
  },
  {
    name: 'docs are built before credentials, synced before invalidation, and invalidation runs last',
    check: assertDocsPublishOrder,
  },
  {
    name: 'CloudFront invalidation includes /docs/*',
    check: assertInvalidationCoversDocs,
  },
  {
    name: 'setup-terraform pins an exact version allowed by required_version',
    check: assertTerraformVersionPinned,
  },
  {
    name: 'deploy-api and deploy-web load AWS credentials after npm ci and the build',
    check: assertCredentialsLoadedAfterBuild,
  },
];

function failingAssertions(workflow: Mapping): string[] {
  return ASSERTIONS.filter(({ check }) => {
    try {
      check(workflow);
      return false;
    } catch {
      return true;
    }
  }).map(({ name }) => name);
}

function findRawStep(workflow: Mapping, jobName: string, marker: string): Mapping {
  const step = rawSteps(getJob(workflow, jobName)).find(
    (candidate) =>
      String(candidate.run ?? '').includes(marker) || usesOf(candidate).includes(marker),
  );
  if (step === undefined) {
    throw new Error(`no step containing "${marker}" in job ${jobName}`);
  }
  return step;
}

function replaceInRun(step: Mapping, from: string, to: string): void {
  const run = step.run;
  if (typeof run !== 'string' || !run.includes(from)) {
    throw new Error(`run text "${from}" not found`);
  }
  step.run = run.replace(from, to);
}

interface Mutation {
  readonly name: string;
  readonly mutate: (workflow: Mapping) => void;
}

function moveStepBefore(workflow: Mapping, jobName: string, step: Mapping, marker: string): void {
  const steps = rawSteps(getJob(workflow, jobName));
  steps.splice(steps.indexOf(step), 1);
  steps.splice(steps.indexOf(findRawStep(workflow, jobName, marker)), 0, step);
}
const MUTATIONS: readonly Mutation[] = [
  {
    name: 'extra permission on plan',
    mutate: (workflow) => {
      asMapping(getJob(workflow, 'plan').permissions, 'permissions').actions = 'write';
    },
  },
  {
    name: 'missing environment on apply',
    mutate: (workflow) => {
      delete getJob(workflow, 'apply').environment;
    },
  },
  {
    name: 'cancel-in-progress true',
    mutate: (workflow) => {
      asMapping(workflow.concurrency, 'concurrency')['cancel-in-progress'] = true;
    },
  },
  {
    name: 'terraform apply inside plan',
    mutate: (workflow) => {
      rawSteps(getJob(workflow, 'plan')).push({
        name: 'Terraform apply',
        run: 'terraform apply -input=false tfplan',
      });
    },
  },
  {
    name: 'upload-artifact step in plan',
    mutate: (workflow) => {
      rawSteps(getJob(workflow, 'plan')).push({
        name: 'Upload plan',
        uses: 'actions/upload-artifact@v4',
        with: { name: 'tfplan', path: 'infra/tfplan' },
      });
    },
  },
  {
    name: 'push trigger',
    mutate: (workflow) => {
      asMapping(workflow.on, 'on').push = { branches: ['master'] };
    },
  },
  {
    name: 'plan gate without the conclusion check',
    mutate: (workflow) => {
      getJob(workflow, 'plan').if =
        "github.event_name == 'workflow_dispatch' || github.event.workflow_run.event == 'push'";
    },
  },
  {
    name: 'dispatch allowed from any branch',
    mutate: (workflow) => {
      getJob(workflow, 'plan').if =
        "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && " +
        "github.event.workflow_run.event == 'push' && " +
        'github.event.workflow_run.head_repository.full_name == github.repository)';
    },
  },
  {
    name: 'dispatch ref check dropped from the dispatch branch only',
    mutate: (workflow) => {
      getJob(workflow, 'plan').if = String(getJob(workflow, 'plan').if).replace(
        " && github.ref == 'refs/heads/master'",
        '',
      );
    },
  },
  {
    name: 'plan gate widened with an always-true clause',
    mutate: (workflow) => {
      getJob(workflow, 'plan').if = `${String(getJob(workflow, 'plan').if)} || true`;
    },
  },
  {
    name: 'AWS credentials before npm ci in deploy-api',
    mutate: (workflow) => {
      const credentials = findRawStep(workflow, 'deploy-api', AWS_CREDENTIALS_PREFIX);
      moveStepBefore(workflow, 'deploy-api', credentials, 'npm ci');
    },
  },
  {
    name: 'AWS credentials before the build in deploy-web',
    mutate: (workflow) => {
      const credentials = findRawStep(workflow, 'deploy-web', AWS_CREDENTIALS_PREFIX);
      moveStepBefore(workflow, 'deploy-web', credentials, 'npm ci');
    },
  },
  {
    name: 'AWS CLI call before the credentials step',
    mutate: (workflow) => {
      const credentials = findRawStep(workflow, 'deploy-web', AWS_CREDENTIALS_PREFIX);
      const steps = rawSteps(getJob(workflow, 'deploy-web'));
      steps.splice(steps.indexOf(credentials), 0, { run: 'aws sts get-caller-identity' });
    },
  },
  {
    name: 'setup-terraform without terraform_version in plan',
    mutate: (workflow) => {
      delete asMapping(findRawStep(workflow, 'plan', SETUP_TERRAFORM_PREFIX).with, 'with')
        .terraform_version;
    },
  },
  {
    name: 'setup-terraform with a floating version in apply',
    mutate: (workflow) => {
      asMapping(
        findRawStep(workflow, 'apply', SETUP_TERRAFORM_PREFIX).with,
        'with',
      ).terraform_version = 'latest';
    },
  },
  {
    name: 'setup-terraform version below required_version',
    mutate: (workflow) => {
      asMapping(
        findRawStep(workflow, 'plan', SETUP_TERRAFORM_PREFIX).with,
        'with',
      ).terraform_version = '1.9.0';
    },
  },
  {
    name: 'setup-terraform version at the excluded upper bound',
    mutate: (workflow) => {
      asMapping(
        findRawStep(workflow, 'apply', SETUP_TERRAFORM_PREFIX).with,
        'with',
      ).terraform_version = '2.0.0';
    },
  },
  {
    name: 'apply checkout by github.sha',
    mutate: (workflow) => {
      asMapping(findRawStep(workflow, 'apply', CHECKOUT_PREFIX).with, 'with').ref =
        '${{ github.sha }}';
    },
  },
  {
    name: 'literal payment public key in env',
    mutate: (workflow) => {
      asMapping(workflow.env, 'env').TF_VAR_payment_public_key = 'pub_test_fake';
    },
  },
  {
    name: 'deploy-api without the apply dependency',
    mutate: (workflow) => {
      getJob(workflow, 'deploy-api').needs = [];
    },
  },
  {
    name: 'plan init without the state bucket',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'plan', 'terraform init'),
        'bucket=$TF_STATE_BUCKET',
        'bucket=fixture-bucket',
      );
    },
  },
  {
    name: 'validate before init',
    mutate: (workflow) => {
      const steps = rawSteps(getJob(workflow, 'plan'));
      const initIndex = steps.indexOf(findRawStep(workflow, 'plan', 'terraform init'));
      const validateIndex = steps.indexOf(findRawStep(workflow, 'plan', 'terraform validate'));
      [steps[initIndex], steps[validateIndex]] = [steps[validateIndex], steps[initIndex]];
    },
  },
  {
    name: 'apply without the saved plan file',
    mutate: (workflow) => {
      findRawStep(workflow, 'apply', 'terraform apply').run =
        'terraform apply -input=false -auto-approve';
    },
  },
  {
    name: 'AWS job without id-token',
    mutate: (workflow) => {
      delete asMapping(getJob(workflow, 'deploy-web').permissions, 'permissions')['id-token'];
    },
  },
  {
    name: 'artifact download in apply',
    mutate: (workflow) => {
      rawSteps(getJob(workflow, 'apply')).push({
        name: 'Download plan',
        uses: 'actions/download-artifact@v4',
      });
    },
  },
  {
    name: 'mutable asset cache policy',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'deploy-web', 'aws s3 sync'),
        'max-age=31536000, immutable',
        'max-age=60',
      );
    },
  },
  {
    name: 'index.html cacheable',
    mutate: (workflow) => {
      replaceInRun(findRawStep(workflow, 'deploy-web', 'aws s3 cp'), '"no-cache"', '"max-age=300"');
    },
  },
  {
    name: 'no CloudFront invalidation',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'deploy-web', 'aws cloudfront'),
        'create-invalidation',
        'list-invalidations',
      );
    },
  },
  {
    name: 'no Lambda code update',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'deploy-api', 'aws lambda'),
        'update-function-code',
        'update-function-configuration',
      );
    },
  },
  {
    name: 'web sync without the docs exclusion',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'deploy-web', 'aws s3 sync web/dist'),
        ' --exclude "docs/*"',
        '',
      );
    },
  },
  {
    name: 'docs sync without --delete',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'deploy-web', 'aws s3 sync docs/site'),
        '/docs" --delete',
        '/docs"',
      );
    },
  },
  {
    name: 'openapi.json cached without no-cache',
    mutate: (workflow) => {
      replaceInRun(
        findRawStep(workflow, 'deploy-web', 'docs/openapi.json'),
        '--cache-control no-cache',
        '--cache-control "max-age=300"',
      );
    },
  },
  {
    name: 'invalidation without /docs/*',
    mutate: (workflow) => {
      replaceInRun(findRawStep(workflow, 'deploy-web', 'create-invalidation'), ' "/docs/*"', '');
    },
  },
  {
    name: 'API docs built without npm ci',
    mutate: (workflow) => {
      replaceInRun(findRawStep(workflow, 'deploy-web', 'npm run docs:site'), 'npm ci && ', '');
    },
  },
  {
    name: 'API docs setup on Node 20',
    mutate: (workflow) => {
      asMapping(findRawStep(workflow, 'deploy-web', SETUP_NODE_PREFIX).with, 'with')[
        'node-version'
      ] = '20';
    },
  },
  {
    name: 'docs published before the AWS credentials step',
    mutate: (workflow) => {
      const publish = findRawStep(workflow, 'deploy-web', 'docs/openapi.json');
      moveStepBefore(workflow, 'deploy-web', publish, AWS_CREDENTIALS_PREFIX);
    },
  },
];

describe('deploy.yml job order, gating and permissions (Property 15)', () => {
  const deployWorkflow = loadDeployWorkflow();

  describe('assertions on the real deploy.yml', () => {
    it.each(ASSERTIONS)('$name', ({ check }) => {
      check(deployWorkflow);
    });

    it('reports no failing assertion', () => {
      expect(failingAssertions(deployWorkflow)).toEqual([]);
    });
  });

  describe('mutations are detected', () => {
    it.each(MUTATIONS)('$name makes at least one assertion fail', ({ mutate }) => {
      const mutant = structuredClone(deployWorkflow);
      mutate(mutant);
      expect(mutant).not.toEqual(deployWorkflow);
      expect(failingAssertions(mutant)).not.toEqual([]);
    });
  });
});
