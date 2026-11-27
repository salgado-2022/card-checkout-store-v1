import * as fs from 'fs';
import * as path from 'path';

// Static checks over the deploy role permission policy in infra/bootstrap/main.tf.
// No terraform binary and no AWS calls: the test reads the Terraform text.

const BOOTSTRAP_DIR = path.resolve(__dirname, '../../../infra/bootstrap');

const ALLOWED_SERVICES = [
  's3',
  'cloudfront',
  'lambda',
  'dynamodb',
  'ssm',
  'iam',
  'logs',
  'budgets',
] as const;

interface PolicyStatement {
  sid: string;
  effect: string;
  actions: string[];
  resources: string[];
  hasCondition: boolean;
  text: string;
}

const mainTf = fs
  .readFileSync(path.join(BOOTSTRAP_DIR, 'main.tf'), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

// Returns the text between the matching delimiters that start at `open`.
function balanced(code: string, open: number, openChar: string, closeChar: string): string {
  let depth = 0;
  let inString = false;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '"' && code[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${openChar} at ${open}`);
}

function resourceBlock(code: string, header: string): string {
  const start = code.indexOf(header);
  if (start === -1) throw new Error(`block not found: ${header}`);
  return balanced(code, code.indexOf('{', start), '{', '}');
}

function quotedValues(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

// Reads the value of `key = ...` (a string or a list) at the top level of a statement.
function attribute(statement: string, key: string): string[] {
  const match = new RegExp(`^\\s{0,12}${key}\\s*=\\s*`, 'm').exec(statement);
  if (!match) return [];
  const valueStart = match.index + match[0].length;
  if (statement[valueStart] === '[') {
    return quotedValues(balanced(statement, valueStart, '[', ']'));
  }
  const lineEnd = statement.indexOf('\n', valueStart);
  return quotedValues(statement.slice(valueStart, lineEnd === -1 ? undefined : lineEnd));
}

function parseStatements(code: string): PolicyStatement[] {
  const policy = resourceBlock(code, 'resource "aws_iam_role_policy" "deploy"');
  const listStart = policy.indexOf('[', policy.indexOf('Statement'));
  const list = balanced(policy, listStart, '[', ']');
  const statements: PolicyStatement[] = [];
  let index = 0;
  while (index < list.length) {
    const open = list.indexOf('{', index);
    if (open === -1) break;
    const body = balanced(list, open, '{', '}');
    statements.push({
      sid: attribute(body, 'Sid')[0],
      effect: attribute(body, 'Effect')[0],
      actions: attribute(body, 'Action'),
      resources: attribute(body, 'Resource'),
      hasCondition: /^\s*Condition\s*=/m.test(body),
      text: body,
    });
    index = open + body.length + 2;
  }
  return statements;
}

const policyBlock = resourceBlock(mainTf, 'resource "aws_iam_role_policy" "deploy"');
const statements = parseStatements(mainTf);

function byService(service: string): PolicyStatement[] {
  return statements.filter((s) => s.actions.some((a) => a.startsWith(`${service}:`)));
}

function bySid(sid: string): PolicyStatement {
  const found = statements.find((s) => s.sid === sid);
  if (!found) throw new Error(`statement not found: ${sid}`);
  return found;
}

describe('infra/bootstrap deploy role policy (static)', () => {
  it('attaches an inline policy to the deploy role with the project prefix', () => {
    expect(policyBlock).toMatch(/role\s*=\s*aws_iam_role\.deploy\.id/);
    expect(policyBlock).toMatch(/name\s*=\s*"\$\{var\.project_name\}-/);
    expect(mainTf).toMatch(/data\s+"aws_caller_identity"\s+"current"\s*{}/);
  });

  it('parses one statement per service block with a unique sid', () => {
    expect(statements.length).toBeGreaterThanOrEqual(ALLOWED_SERVICES.length);
    for (const s of statements) {
      expect(s.sid).toBeTruthy();
      expect(['Allow', 'Deny']).toContain(s.effect);
      expect(s.actions.length).toBeGreaterThan(0);
      expect(s.resources.length).toBeGreaterThan(0);
    }
    const sids = statements.map((s) => s.sid);
    expect(new Set(sids).size).toBe(sids.length);
  });

  it('has no "*:*", no iam:*, no service-wide wildcard and no user or access key actions', () => {
    expect(policyBlock).not.toContain('"*:*"');
    expect(policyBlock).not.toContain('iam:*');
    expect(policyBlock).not.toContain('iam:CreateUser');
    expect(policyBlock).not.toContain('iam:CreateAccessKey');
    for (const s of statements) {
      for (const action of s.actions) {
        expect(action).toMatch(/^[a-z0-9]+:[A-Za-z]+$/);
      }
    }
  });

  it('uses Resource "*" only for CloudFront actions, ssm:DescribeParameters and logs:DescribeLogGroups', () => {
    const allowedWildcardActions = (action: string): boolean =>
      action.startsWith('cloudfront:') ||
      action === 'ssm:DescribeParameters' ||
      action === 'logs:DescribeLogGroups';
    const wildcard = statements.filter((s) => s.resources.includes('*'));
    expect(wildcard.map((s) => s.sid).sort()).toEqual(
      ['CloudFront', 'LogsDescribeLogGroups', 'SsmDescribeParameters'].sort(),
    );
    for (const s of wildcard) {
      expect(s.resources).toEqual(['*']);
      expect(s.actions.every(allowedWildcardActions)).toBe(true);
    }
    expect(bySid('SsmDescribeParameters').actions).toEqual(['ssm:DescribeParameters']);
    expect(bySid('LogsDescribeLogGroups').actions).toEqual(['logs:DescribeLogGroups']);
  });

  it('scopes every non-wildcard resource to an ARN or the state bucket', () => {
    for (const s of statements) {
      if (s.resources.includes('*')) continue;
      for (const resource of s.resources) {
        expect(resource).not.toBe('*');
        expect(resource).toMatch(/^(arn:aws:|\$\{aws_s3_bucket\.state\.arn\})/);
      }
    }
  });

  it('limits IAM to the exact Lambda execution role, with PassRole conditioned on lambda', () => {
    const roleArn =
      'arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-lambda-exec';
    const iamAllows = byService('iam').filter((s) => s.effect === 'Allow');
    expect(iamAllows.length).toBeGreaterThanOrEqual(3);
    for (const s of iamAllows) {
      expect(s.actions.every((a) => a.startsWith('iam:'))).toBe(true);
      expect(s.resources).toEqual([roleArn]);
    }
    const passRole = iamAllows.filter((s) => s.actions.includes('iam:PassRole'));
    expect(passRole).toHaveLength(1);
    expect(passRole[0].actions).toEqual(['iam:PassRole']);
    expect(passRole[0].hasCondition).toBe(true);
    expect(passRole[0].text).toMatch(/"iam:PassedToService"\s*=\s*"lambda\.amazonaws\.com"/);
  });
  it('never grants AttachRolePolicy, DetachRolePolicy or any action on IAM policies', () => {
    const actions = statements.flatMap((s) => (s.effect === 'Allow' ? s.actions : []));
    expect(actions).not.toContain('iam:AttachRolePolicy');
    expect(actions).not.toContain('iam:DetachRolePolicy');
    expect(actions).not.toContain('iam:DeleteRolePermissionsBoundary');
    expect(
      actions.filter(
        (a) =>
          /Policy(Version|Versions)?$/.test(a) && a.startsWith('iam:') && !/RolePolicy$/.test(a),
      ),
    ).toEqual([]);
    expect(policyBlock).not.toContain(':policy/');
    expect(policyBlock).not.toMatch(/\bpolicy\/\*/);
    expect(policyBlock).not.toContain('iam:CreatePolicy');
    expect(policyBlock).not.toContain('iam:SetDefaultPolicyVersion');
  });
  it('requires the permissions boundary on every action that creates or changes role permissions', () => {
    const bounded = statements.filter((s) =>
      s.actions.some((a) =>
        [
          'iam:CreateRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:PutRolePermissionsBoundary',
        ].includes(a),
      ),
    );
    expect(bounded).toHaveLength(1);
    expect(bounded[0].effect).toBe('Allow');
    expect(bounded[0].actions.sort()).toEqual(
      [
        'iam:CreateRole',
        'iam:DeleteRolePolicy',
        'iam:PutRolePermissionsBoundary',
        'iam:PutRolePolicy',
      ].sort(),
    );
    expect(bounded[0].text).toMatch(
      /StringEquals\s*=\s*{\s*"iam:PermissionsBoundary"\s*=\s*aws_iam_policy\.lambda_boundary\.arn\s*}/,
    );
    for (const s of byService('iam')) {
      if (s === bounded[0]) continue;
      expect(s.actions).not.toContain('iam:CreateRole');
      expect(s.actions).not.toContain('iam:PutRolePolicy');
    }
  });
  it('explicitly denies removing a permissions boundary from any role', () => {
    const deny = bySid('IamDenyBoundaryRemoval');
    expect(deny.effect).toBe('Deny');
    expect(deny.actions).toEqual(['iam:DeleteRolePermissionsBoundary']);
    expect(deny.resources).toEqual([
      'arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/*',
    ]);
  });
  it('defines the lambda boundary policy with only the actions the Lambda needs', () => {
    const boundary = resourceBlock(mainTf, 'resource "aws_iam_policy" "lambda_boundary"');
    expect(boundary).toMatch(/name\s*=\s*"\$\{var\.project_name\}-lambda-boundary"/);
    const allowed = quotedValues(boundary).filter((v) => /^[a-z0-9]+:[A-Za-z]+$/.test(v));
    expect(allowed.sort()).toEqual(
      [
        'dynamodb:ConditionCheckItem',
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'ssm:GetParameter',
      ].sort(),
    );
    expect(boundary).toContain('parameter/${var.project_name}/*');
    expect(boundary).toContain('table/${var.project_name}-*/index/*');
    expect(boundary).toContain('log-group:/aws/lambda/${var.project_name}-*');
    expect(boundary).not.toMatch(/Resource\s*=\s*"\*"/);
    expect(fs.readFileSync(path.join(BOOTSTRAP_DIR, 'outputs.tf'), 'utf8')).toMatch(
      /output\s+"lambda_boundary_arn"[\s\S]*aws_iam_policy\.lambda_boundary\.arn/,
    );
  });
  it('prefixes S3 web, Lambda, DynamoDB, SSM, Logs and Budgets resources with project_name', () => {
    const expectations: Record<string, string[]> = {
      WebBucket: ['arn:aws:s3:::${var.project_name}-web', 'arn:aws:s3:::${var.project_name}-web/*'],
      Lambda: [
        'arn:aws:lambda:us-east-1:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-*',
      ],
      DynamoDb: [
        'arn:aws:dynamodb:us-east-1:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-*',
        'arn:aws:dynamodb:us-east-1:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-*/index/*',
      ],
      SsmOriginParameter: [
        'arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/origin/*',
      ],
      LogsLambdaLogGroup: [
        'arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-*',
      ],
      BudgetsProjectBudget: [
        'arn:aws:budgets::${data.aws_caller_identity.current.account_id}:budget/${var.project_name}-monthly-cost',
      ],
    };
    for (const [sid, resources] of Object.entries(expectations)) {
      expect(bySid(sid).resources).toEqual(resources);
    }
    for (const service of ['s3', 'lambda', 'dynamodb', 'ssm', 'logs', 'budgets']) {
      for (const s of byService(service)) {
        if (s.resources.includes('*') || s.sid === 'TerraformStateBucket') continue;
        for (const resource of s.resources) {
          expect(resource).toContain('${var.project_name}');
        }
      }
    }
  });

  it('grants the state bucket statement on the bucket and bucket/* only, with the five S3 actions', () => {
    const state = bySid('TerraformStateBucket');
    expect(state.actions.sort()).toEqual(
      [
        's3:DeleteObject',
        's3:GetBucketVersioning',
        's3:GetObject',
        's3:ListBucket',
        's3:PutObject',
      ].sort(),
    );
    expect(state.resources).toEqual(['${aws_s3_bucket.state.arn}/*']);
    expect(state.text).toMatch(
      /Resource\s*=\s*\[\s*aws_s3_bucket\.state\.arn,\s*"\$\{aws_s3_bucket\.state\.arn\}\/\*",\s*\]/,
    );
    expect(state.text).toContain('aws_s3_bucket.state.arn');
  });

  it('covers only the origin SSM prefix and grants nothing on /payment/', () => {
    const ssm = byService('ssm');
    expect(ssm.map((s) => s.sid).sort()).toEqual(['SsmDescribeParameters', 'SsmOriginParameter']);
    expect(bySid('SsmOriginParameter').resources[0]).toMatch(
      /parameter\/\$\{var\.project_name\}\/origin\/\*$/,
    );
    expect(policyBlock).not.toMatch(/\/payment\b/i);
    expect(policyBlock).not.toContain('/payment/');
    expect(policyBlock).not.toMatch(/parameter\/\*|parameter\/\$\{var\.project_name\}\/\*/);
  });

  it('does not reference the OIDC provider or the deploy role in any statement', () => {
    const statementsText = statements.map((s) => s.text).join('\n');
    expect(statementsText).not.toContain('aws_iam_openid_connect_provider');
    expect(statementsText).not.toContain('oidc-provider');
    expect(statementsText).not.toContain('aws_iam_role.deploy');
    expect(statementsText).not.toMatch(/\$\{var\.project_name\}-deploy/);
    for (const resource of statements.flatMap((s) => s.resources)) {
      expect(resource).not.toMatch(/role\/\$\{var\.project_name\}-deploy/);
      expect(resource).not.toContain('oidc-provider');
    }
  });

  it('uses only the eight services of Requirement 20.4', () => {
    const services = new Set(statements.flatMap((s) => s.actions.map((a) => a.split(':')[0])));
    expect([...services].sort()).toEqual([...ALLOWED_SERVICES].sort());
    for (const s of statements) {
      const own = new Set(s.actions.map((a) => a.split(':')[0]));
      expect(own.size).toBe(1);
    }
  });

  it('has no secret-like literals', () => {
    expect(policyBlock).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(policyBlock).not.toMatch(/\bprv_[A-Za-z0-9]/);
  });
});
