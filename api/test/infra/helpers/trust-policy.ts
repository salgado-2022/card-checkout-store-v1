// Pure helper: parses the deploy trust policy block of infra/bootstrap HCL text and
// evaluates a GitHub OIDC claim set against it (IAM StringEquals semantics).

export interface TrustCondition {
  test: string;
  variable: string;
  values: string[];
}

export interface TrustPrincipal {
  type: string;
  identifiers: string[];
}

export interface TrustPolicy {
  actions: string[];
  principals: TrustPrincipal[];
  tests: string[];
  aud: string[];
  subs: string[];
  conditions: TrustCondition[];
}

export interface ClaimSet {
  aud: string;
  sub: string;
}

export interface RepositoryVariables {
  github_owner: string;
  github_owner_id: string;
  github_repo: string;
  github_repo_id: string;
}

const AUD_VARIABLE = 'token.actions.githubusercontent.com:aud';
const SUB_VARIABLE = 'token.actions.githubusercontent.com:sub';
export const ASSUME_ACTION = 'sts:AssumeRoleWithWebIdentity';

function blockBody(code: string, header: string, from = 0): { body: string; end: number } {
  const start = code.indexOf(header, from);
  if (start === -1) {
    throw new Error(`block not found: ${header}`);
  }
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: code.slice(open + 1, i), end: i + 1 };
      }
    }
  }
  throw new Error(`unterminated block: ${header}`);
}

function allBlocks(code: string, header: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  while (code.indexOf(header, from) !== -1) {
    const { body, end } = blockBody(code, header, from);
    bodies.push(body);
    from = end;
  }
  return bodies;
}

function stringList(body: string, attribute: string): string[] {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*\\[([^\\]]*)\\]`).exec(body);
  if (!match) {
    throw new Error(`list attribute not found: ${attribute}`);
  }
  // Items are quoted strings or bare references such as aws_x.y.arn.
  return [...match[1].matchAll(/"([^"]*)"|([\w.]+)/g)].map((item) => item[1] ?? item[2]);
}

function stringValue(body: string, attribute: string): string {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`).exec(body);
  if (!match) {
    throw new Error(`attribute not found: ${attribute}`);
  }
  return match[1];
}

function resolveVariables(value: string, variables: RepositoryVariables): string {
  return value
    .replaceAll('${var.github_owner}', variables.github_owner)
    .replaceAll('${var.github_owner_id}', variables.github_owner_id)
    .replaceAll('${var.github_repo}', variables.github_repo)
    .replaceAll('${var.github_repo_id}', variables.github_repo_id);
}

export function parseTrustPolicy(hcl: string, variables: RepositoryVariables): TrustPolicy {
  const code = hcl
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const { body: document } = blockBody(code, 'data "aws_iam_policy_document" "deploy_trust"');
  const statement = blockBody(document, 'statement').body;
  const principals = allBlocks(statement, 'principals').map((body) => ({
    type: stringValue(body, 'type'),
    identifiers: stringList(body, 'identifiers'),
  }));
  const conditions = allBlocks(statement, 'condition').map((body) => ({
    test: stringValue(body, 'test'),
    variable: stringValue(body, 'variable'),
    values: stringList(body, 'values').map((value) => resolveVariables(value, variables)),
  }));
  const valuesOf = (variable: string): string[] =>
    conditions.filter((condition) => condition.variable === variable).flatMap((c) => c.values);
  return {
    actions: stringList(statement, 'actions'),
    principals,
    tests: conditions.map((condition) => condition.test),
    aud: valuesOf(AUD_VARIABLE),
    subs: valuesOf(SUB_VARIABLE),
    conditions,
  };
}

// A claim set is admitted when the action is allowed and every condition holds.
// Every condition here is StringEquals; any other operator is rejected as unsupported.
export function admits(policy: TrustPolicy, claims: ClaimSet): boolean {
  if (!policy.actions.includes(ASSUME_ACTION)) {
    return false;
  }
  const claimByVariable: Record<string, string> = {
    [AUD_VARIABLE]: claims.aud,
    [SUB_VARIABLE]: claims.sub,
  };
  return policy.conditions.every((condition) => {
    if (condition.test !== 'StringEquals') {
      throw new Error(`unsupported condition operator: ${condition.test}`);
    }
    const claim = claimByVariable[condition.variable];
    return claim !== undefined && condition.values.includes(claim);
  });
}
