import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { admits, parseTrustPolicy } from './helpers/trust-policy';

const BOOTSTRAP_DIR = path.resolve(__dirname, '../../../infra/bootstrap');
const OWNER = 'salgado-2022';
const REPO = 'card-checkout-store';
const MASTER_SUB = `repo:${OWNER}/${REPO}:ref:refs/heads/master`;
const PRODUCTION_SUB = `repo:${OWNER}/${REPO}:environment:production`;
const AUDIENCE = 'sts.amazonaws.com';

const mainTf = fs.readFileSync(path.join(BOOTSTRAP_DIR, 'main.tf'), 'utf8');
const outputsTf = fs.readFileSync(path.join(BOOTSTRAP_DIR, 'outputs.tf'), 'utf8');
const policy = parseTrustPolicy(mainTf, { github_owner: OWNER, github_repo: REPO });

function blockText(code: string, header: string): string {
  const start = code.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = code.indexOf('\n}', start);
  return code.slice(start, end + 2);
}

describe('bootstrap deploy role trust policy', () => {
  it('declares a single assume-role-with-web-identity action', () => {
    expect(policy.actions).toEqual(['sts:AssumeRoleWithWebIdentity']);
  });

  it('trusts only the GitHub OIDC provider as a federated principal', () => {
    expect(policy.principals).toEqual([
      { type: 'Federated', identifiers: ['local.github_oidc_provider_arn'] },
    ]);
  });

  it('uses StringEquals for every condition and no wildcards', () => {
    expect(policy.tests).toEqual(['StringEquals', 'StringEquals']);
    const trustBlock = blockText(mainTf, 'data "aws_iam_policy_document" "deploy_trust"');
    expect(trustBlock).not.toMatch(/StringLike/);
    expect(trustBlock).not.toContain('*');
    expect(policy.aud).toEqual([AUDIENCE]);
    expect(policy.subs).toEqual([MASTER_SUB, PRODUCTION_SUB]);
  });

  it('builds the subjects from the repository variables', () => {
    const trustBlock = blockText(mainTf, 'data "aws_iam_policy_document" "deploy_trust"');
    expect(trustBlock).toContain(
      '"repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/master"',
    );
    expect(trustBlock).toContain(
      '"repo:${var.github_owner}/${var.github_repo}:environment:production"',
    );
  });

  it('references the existing OIDC provider by ARN built from the account id', () => {
    const locals = blockText(mainTf, 'locals {');
    expect(locals).toContain(
      'github_oidc_provider_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"',
    );
    expect(mainTf).not.toMatch(/aws_iam_openid_connect_provider/);
  });

  it('defines the deploy role with a one hour session and the project prefix', () => {
    const role = blockText(mainTf, 'resource "aws_iam_role" "deploy"');
    expect(role).toMatch(/max_session_duration\s*=\s*3600/);
    expect(role).toMatch(/name\s*=\s*"\$\{var\.project_name\}-/);
    expect(role).toMatch(
      /assume_role_policy\s*=\s*data\.aws_iam_policy_document\.deploy_trust\.json/,
    );
  });

  it('exports the deploy role ARN', () => {
    expect(outputsTf).toMatch(/output\s+"deploy_role_arn"\s*{/);
    expect(outputsTf).toMatch(/value\s*=\s*aws_iam_role\.deploy\.arn/);
  });

  it.each([
    ['master branch', MASTER_SUB],
    ['production environment', PRODUCTION_SUB],
  ])('admits the %s with the exact audience', (_label, sub) => {
    expect(admits(policy, { aud: AUDIENCE, sub })).toBe(true);
  });

  it.each([
    ['pull request', `repo:${OWNER}/${REPO}:pull_request`],
    ['other branch', `repo:${OWNER}/${REPO}:ref:refs/heads/develop`],
    ['tag', `repo:${OWNER}/${REPO}:ref:refs/tags/v1`],
    ['other environment', `repo:${OWNER}/${REPO}:environment:staging`],
    ['other repository', `repo:${OWNER}/other:ref:refs/heads/master`],
    ['other owner', `repo:someone/${REPO}:ref:refs/heads/master`],
    ['wildcard', `repo:${OWNER}/${REPO}:*`],
    ['prefix', `${MASTER_SUB}-extra`],
  ])('rejects the %s subject', (_label, sub) => {
    expect(admits(policy, { aud: AUDIENCE, sub })).toBe(false);
  });

  it('rejects a wrong audience even with a valid subject', () => {
    expect(admits(policy, { aud: 'sts.amazonaws.com.evil', sub: MASTER_SUB })).toBe(false);
  });

  it('rejects every claim set when the action is not allowed', () => {
    const noAction = { ...policy, actions: ['sts:AssumeRole'] };
    expect(admits(noAction, { aud: AUDIENCE, sub: MASTER_SUB })).toBe(false);
  });

  it('fails loudly on an unsupported condition operator', () => {
    const like = {
      ...policy,
      conditions: [{ test: 'StringLike', variable: 'x', values: ['*'] }],
    };
    expect(() => admits(like, { aud: AUDIENCE, sub: MASTER_SUB })).toThrow(/unsupported/);
  });

  it('fails when the trust policy block is missing', () => {
    expect(() => parseTrustPolicy('', { github_owner: OWNER, github_repo: REPO })).toThrow(
      /block not found/,
    );
  });

  it('Feature: platform-foundation, Property 12: admits only the exact audience with the master or production subject', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    const subjects = fc.oneof(
      fc.constant(MASTER_SUB),
      fc.constant(PRODUCTION_SUB),
      fc.string(),
      fc.tuple(segment, segment, segment).map(([o, r, b]) => `repo:${o}/${r}:ref:refs/heads/${b}`),
      fc.tuple(segment, segment).map(([o, r]) => `repo:${o}/${r}:environment:production`),
      fc.tuple(segment, segment).map(([o, r]) => `repo:${o}/${r}:environment:${o}`),
      segment.map((n) => `repo:${OWNER}/${REPO}:pull_request:${n}`),
      segment.map((b) => `repo:${OWNER}/${REPO}:ref:refs/heads/${b}`),
      segment.map((e) => `repo:${OWNER}/${REPO}:environment:${e}`),
      fc
        .constantFrom(MASTER_SUB, PRODUCTION_SUB)
        .chain((s) =>
          fc.constantFrom(`${s}*`, `${s}x`, `x${s}`, s.toUpperCase(), ` ${s}`, `${s}\n`),
        ),
      fc.constantFrom(`repo:${OWNER}/${REPO}:*`, 'repo:*', '*', `repo:${OWNER}/*`),
    );
    const audiences = fc.oneof(
      fc.constant(AUDIENCE),
      fc.string(),
      fc.constantFrom('', '*', 'sts.amazonaws.com.', 'STS.AMAZONAWS.COM', ` ${AUDIENCE}`),
    );
    fc.assert(
      fc.property(audiences, subjects, (aud, sub) => {
        const expected = aud === AUDIENCE && (sub === MASTER_SUB || sub === PRODUCTION_SUB);
        return admits(policy, { aud, sub }) === expected;
      }),
      { numRuns: 500 },
    );
  });
});
