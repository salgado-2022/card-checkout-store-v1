import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEPLOYMENT_DOC = path.join(REPO_ROOT, 'docs', 'deployment.md');
const INFRA_README = path.join(REPO_ROOT, 'infra', 'README.md');
const DEPLOY_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');
const WORDS_FILE = path.join(REPO_ROOT, '.kiro', 'private', 'forbidden-words.txt');

const WORDS_EXIST = fs.existsSync(WORDS_FILE);
if (!WORDS_EXIST) {
  console.warn(`deployment-docs: ${WORDS_FILE} not found, forbidden-word check skipped`);
}

const SECTION_HEADINGS = [
  '1. Prerequisites',
  '2. Bootstrap',
  '3. Production environment',
  '4. Deploy variables',
  '5. First deployment run',
  '6. Payment secrets',
  '7. Verification',
  '8. Security notes',
];

const DEPLOY_VARIABLES = [
  'AWS_ROLE_ARN',
  'AWS_REGION',
  'TF_STATE_BUCKET',
  'BUDGET_NOTIFICATION_EMAIL',
  'PAYMENT_API_URL',
  'PAYMENT_PUBLIC_KEY',
];

const LOCAL_COMMANDS = [
  'terraform fmt -check -recursive',
  'terraform init -backend=false',
  'terraform validate',
];

const FORBIDDEN_COMMANDS = ['terraform destroy', 'terraform taint'];

function readForbiddenWords(): string[] {
  return fs
    .readFileSync(WORDS_FILE, 'utf8')
    .split(/\r?\n/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
}

describe('docs/deployment.md', () => {
  const doc = fs.readFileSync(DEPLOYMENT_DOC, 'utf8');
  const lower = doc.toLowerCase();

  it('starts with the H1 "Deployment guide"', () => {
    expect(doc.split('\n')[0]).toBe('# Deployment guide');
  });

  it('has exactly the eight level-2 sections, in order', () => {
    const headings = [...doc.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
    expect(headings).toEqual(SECTION_HEADINGS);
  });

  it.each(DEPLOY_VARIABLES)('documents the deploy variable %s', (name) => {
    expect(doc).toContain(`\`${name}\``);
  });

  it('uses us-east-2 for every regional command and never us-east-1', () => {
    expect(doc).toContain('`us-east-2`');
    expect(doc).not.toContain('us-east-1');
  });

  it('states that the GitHub OIDC provider already exists and is not created by the bootstrap', () => {
    expect(doc).toContain('already present in the AWS account');
    expect(doc).toContain('does not create, import or read it');
    expect(doc).not.toMatch(/IAM OIDC providers/);
  });

  it('creates payment secrets as SecureString from a local file', () => {
    expect(doc).toContain('--type SecureString');
    expect(doc).toContain('file://');
  });

  it('explains how to overwrite a payment secret', () => {
    expect(doc).toContain('--overwrite');
  });

  it('explains that a secret change needs a Lambda cold start', () => {
    expect(lower).toContain('cold start');
  });

  it('requires protecting master and a required reviewer on production', () => {
    expect(doc).toContain('Protect `master`');
    expect(lower).toContain('required reviewer');
  });

  it('describes origin secret rotation through the origin_secret_rotation variable', () => {
    expect(doc).toContain('keepers');
    expect(doc).toContain('random_password.origin_verify');
    expect(doc).toContain('`origin_secret_rotation`');
    expect(doc).toContain('infra/variables.tf');
    expect(lower).toContain('pull request');
  });
  it('states that the smoke test accepts only https URLs', () => {
    expect(doc).toContain('start with `https://`');
    expect(doc).toContain("--proto '=https'");
  });
  it('states that manual dispatch must run from master', () => {
    expect(doc).toContain('Dispatch from `master` only');
  });
  it('states the Terraform version pinned by the workflow, matching deploy.yml', () => {
    const workflow = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8');
    const pinned = [...workflow.matchAll(/terraform_version:\s*(\S+)/g)].map((match) => match[1]);
    expect(pinned.length).toBeGreaterThan(0);
    for (const version of pinned) {
      expect(doc).toContain(`pins Terraform ${version}`);
    }
  });

  it.each(FORBIDDEN_COMMANDS)('does not instruct to run "%s"', (command) => {
    expect(lower).not.toContain(command);
  });

  it('contains no private key literal (prv_)', () => {
    expect(doc).not.toMatch(/prv_/);
  });

  const forbiddenIt = WORDS_EXIST ? it : it.skip;
  forbiddenIt('contains no forbidden word', () => {
    const offenders = readForbiddenWords().filter((word) => lower.includes(word));
    expect(offenders).toEqual([]);
  });
});

describe('infra/README.md', () => {
  const readme = fs.readFileSync(INFRA_README, 'utf8');

  it.each(LOCAL_COMMANDS)('documents the local command "%s"', (command) => {
    expect(readme).toContain(command);
  });

  it('names us-east-2 and not us-east-1', () => {
    expect(readme).toContain('us-east-2');
    expect(readme).not.toContain('us-east-1');
  });

  it('links to docs/deployment.md', () => {
    expect(readme).toContain('](../docs/deployment.md)');
  });

  const forbiddenIt = WORDS_EXIST ? it : it.skip;
  forbiddenIt('contains no forbidden word', () => {
    const lower = readme.toLowerCase();
    const offenders = readForbiddenWords().filter((word) => lower.includes(word));
    expect(offenders).toEqual([]);
  });
});
