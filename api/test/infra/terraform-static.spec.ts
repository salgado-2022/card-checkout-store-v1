import * as fs from 'node:fs';
import * as path from 'node:path';

// Static checks over the root Terraform module (infra/*.tf, not infra/bootstrap).
// The files are read as text: no terraform binary and no AWS calls.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');
const WORDS_FILE = path.join(REPO_ROOT, '.kiro/private/forbidden-words.txt');

interface Block {
  labels: string[];
  body: string;
}

function stripFullLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('#') && !trimmed.startsWith('//');
    })
    .join('\n');
}

function readRootModule(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of fs
    .readdirSync(INFRA_DIR)
    .filter((n) => n.endsWith('.tf'))
    .sort()) {
    files[name] = fs.readFileSync(path.join(INFRA_DIR, name), 'utf8');
  }
  return files;
}

// Returns the index of the brace that closes the block opened at `open`.
function closingIndex(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces in Terraform text');
}

// Finds every block of a given kind (resource, data, variable, backend, ...) at any indentation.
function parseBlocks(text: string, kind: string): Block[] {
  const header = new RegExp(`^[ \\t]*${kind}((?:[ \\t]+"[^"\\n]*")*)[ \\t]*\\{`, 'gm');
  const blocks: Block[] = [];
  for (const match of text.matchAll(header)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const labels = [...match[1].matchAll(/"([^"]*)"/g)].map((label) => label[1]);
    blocks.push({ labels, body: text.slice(open + 1, closingIndex(text, open)) });
  }
  return blocks;
}

// Keeps only the arguments written directly in a block body, without nested blocks.
function topLevel(body: string): string {
  let depth = 0;
  let out = '';
  for (const ch of body) {
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

function attribute(text: string, name: string): string {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.+)$`, 'm').exec(text);
  if (!match) {
    throw new Error(`attribute not found: ${name}`);
  }
  return match[1].trim();
}

function numericAttribute(text: string, name: string): number {
  return Number(attribute(text, name));
}

const files = readRootModule();
const codeFiles: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([name, text]) => [name, stripFullLineComments(text)]),
);
const rawText = Object.values(files).join('\n');
const code = Object.values(codeFiles).join('\n');

function resourcesOf(type: string, text = code): Block[] {
  return parseBlocks(text, 'resource').filter((block) => block.labels[0] === type);
}

function nestedBlocksOf(body: string, kind: string): Block[] {
  return parseBlocks(body, kind);
}

function findBlock(blocks: Block[], label: string): Block {
  const block = blocks.find((candidate) => candidate.labels.includes(label));
  if (!block) {
    throw new Error(`block not found: ${label}`);
  }
  return block;
}

// Checks that take text so a mutated copy can prove the check fails.
function isSensitiveVariable(variablesText: string, name: string): boolean {
  const variable = findBlock(parseBlocks(variablesText, 'variable'), name);
  return /^[ \t]*sensitive[ \t]*=[ \t]*true[ \t]*$/m.test(topLevel(variable.body));
}
function hasOriginSecretRotation(variablesText: string, ssmText: string): boolean {
  const variable = findBlock(parseBlocks(variablesText, 'variable'), 'origin_secret_rotation');
  const level = topLevel(variable.body);
  const password = findBlock(resourcesOf('random_password', ssmText), 'origin_verify');
  const keepersAssignment = /^[ \t]*keepers[ \t]*=[ \t]*\{([^}]*)\}/m.exec(password.body);
  return (
    attribute(level, 'type') === 'string' &&
    attribute(level, 'default') === '"1"' &&
    keepersAssignment !== null &&
    /^[ \t]*rotation[ \t]*=[ \t]*var\.origin_secret_rotation[ \t]*$/m.test(keepersAssignment[1])
  );
}
const WORDS_EXIST = fs.existsSync(WORDS_FILE);
if (!WORDS_EXIST) {
  console.warn(`terraform-static: ${WORDS_FILE} not found, forbidden-word check skipped`);
}

function readForbiddenWords(): string[] {
  if (!WORDS_EXIST) return [];
  return fs
    .readFileSync(WORDS_FILE, 'utf8')
    .split(/\r?\n/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
}

describe('infra/*.tf root module (static)', () => {
  it('reads the root module files', () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['lambda.tf', 'dynamodb.tf', 'ssm.tf']),
    );
  });

  describe('region and backend', () => {
    it('configures the AWS provider in us-east-2', () => {
      const provider = parseBlocks(code, 'provider').find((block) => block.labels[0] === 'aws');
      expect(provider).toBeDefined();
      expect(attribute(topLevel(provider?.body ?? ''), 'region')).toBe('"us-east-2"');
    });

    it('uses only us-east-2 as a region literal', () => {
      const regions = [...code.matchAll(/region[ \t]*=[ \t]*"([^"]*)"/g)].map((m) => m[1]);
      expect(regions.length).toBeGreaterThan(0);
      expect(new Set(regions)).toEqual(new Set(['us-east-2']));
    });

    it('declares an s3 backend with use_lockfile and encrypt', () => {
      const backend = parseBlocks(code, 'backend').find((block) => block.labels[0] === 's3');
      expect(backend).toBeDefined();
      const args = topLevel(backend?.body ?? '');
      expect(args).toMatch(/use_lockfile[ \t]*=[ \t]*true/);
      expect(args).toMatch(/encrypt[ \t]*=[ \t]*true/);
    });

    it('leaves bucket, key and region out of the backend block', () => {
      const backend = parseBlocks(code, 'backend').find((block) => block.labels[0] === 's3');
      expect(topLevel(backend?.body ?? '')).not.toMatch(/\b(bucket|key|region)[ \t]*=/);
    });

    it('has no dynamodb_table argument and no DynamoDB lock table', () => {
      expect(code).not.toMatch(/\bdynamodb_table[ \t]*=/);
      const tableNames = resourcesOf('aws_dynamodb_table').map((block) => block.labels[1]);
      expect(tableNames.filter((name) => /lock/i.test(name))).toEqual([]);
    });
  });

  describe('forbidden services', () => {
    it.each([
      'aws_api_gateway',
      'aws_apigatewayv2',
      'aws_vpc',
      'aws_nat_gateway',
      'aws_db_instance',
      'aws_rds',
      'aws_secretsmanager',
      'aws_wafv2',
      'aws_route53',
      'aws_lb',
      'aws_alb',
      'PAY_PER_REQUEST',
    ])('does not use %s', (forbidden) => {
      expect(code).not.toContain(forbidden);
    });
  });

  describe('DynamoDB provisioned capacity', () => {
    const tables = resourcesOf('aws_dynamodb_table');

    it('declares the five business tables', () => {
      expect(tables).toHaveLength(5);
    });

    it('uses PROVISIONED billing for every table', () => {
      for (const table of tables) {
        expect(attribute(topLevel(table.body), 'billing_mode')).toBe('"PROVISIONED"');
      }
    });

    it('sums tables and GSIs to 12 read and 12 write capacity units', () => {
      let read = 0;
      let write = 0;
      for (const table of tables) {
        const units = [table, ...nestedBlocksOf(table.body, 'global_secondary_index')];
        for (const unit of units) {
          const level = topLevel(unit.body);
          read += numericAttribute(level, 'read_capacity');
          write += numericAttribute(level, 'write_capacity');
        }
      }
      expect(read).toBe(12);
      expect(write).toBe(12);
    });

    it('keeps each provisioned capacity within the 25 units free tier limit', () => {
      for (const table of tables) {
        const level = topLevel(table.body);
        expect(numericAttribute(level, 'read_capacity')).toBeLessThanOrEqual(25);
        expect(numericAttribute(level, 'write_capacity')).toBeLessThanOrEqual(25);
      }
    });
  });

  describe('Lambda and logs', () => {
    it('runs the API Lambda on nodejs22.x with 512 MB and a 25 s timeout', () => {
      const lambda = findBlock(resourcesOf('aws_lambda_function'), 'api');
      const level = topLevel(lambda.body);
      expect(attribute(level, 'runtime')).toBe('"nodejs22.x"');
      expect(numericAttribute(level, 'memory_size')).toBe(512);
      expect(numericAttribute(level, 'timeout')).toBe(25);
    });
    it('keeps the Lambda environment on exactly the tech-rule variable names', () => {
      const lambda = findBlock(resourcesOf('aws_lambda_function'), 'api');
      const environment = nestedBlocksOf(lambda.body, 'environment');
      expect(environment).toHaveLength(1);
      const names = [...environment[0].body.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=/gm)]
        .map((match) => match[1])
        .sort();
      expect(names).toEqual(
        [
          'BASE_FEE_IN_CENTS',
          'DELIVERY_FEE_IN_CENTS',
          'DYNAMODB_TABLE_CUSTOMERS',
          'DYNAMODB_TABLE_DELIVERIES',
          'DYNAMODB_TABLE_IDEMPOTENCY_KEYS',
          'DYNAMODB_TABLE_PRODUCTS',
          'DYNAMODB_TABLE_TRANSACTIONS',
          'ORIGIN_VERIFY_SECRET_PARAM',
          'PAYMENT_API_URL',
          'PAYMENT_EVENTS_SECRET_PARAM',
          'PAYMENT_INTEGRITY_SECRET_PARAM',
          'PAYMENT_PRIVATE_KEY_PARAM',
          'PAYMENT_PUBLIC_KEY',
        ].sort(),
      );
    });

    it('attaches the lambda-boundary permissions boundary to the execution role', () => {
      const role = findBlock(resourcesOf('aws_iam_role'), 'lambda_exec');
      expect(role.body).toMatch(
        /permissions_boundary[ \t]*=[ \t]*"arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:policy\/\$\{var\.project_name\}-lambda-boundary"/,
      );
    });
    it('grants both Function URL invoke permissions', () => {
      const permissions = resourcesOf('aws_lambda_permission')
        .map((block) => block.body)
        .join('\n');
      expect(permissions).toMatch(/action[ \t]*=[ \t]*"lambda:InvokeFunctionUrl"/);
      expect(permissions).toMatch(/action[ \t]*=[ \t]*"lambda:InvokeFunction"/);
    });

    it('keeps every CloudWatch log group for 7 days', () => {
      const groups = resourcesOf('aws_cloudwatch_log_group');
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(numericAttribute(topLevel(group.body), 'retention_in_days')).toBe(7);
      }
    });
  });

  describe('CloudFront', () => {
    const distribution = findBlock(resourcesOf('aws_cloudfront_distribution'), 'web');
    const headersPolicy = findBlock(
      resourcesOf('aws_cloudfront_response_headers_policy'),
      'security',
    );

    it('does not use custom error responses', () => {
      expect(code).not.toMatch(/custom_error_response/);
    });

    it('redirects viewers to HTTPS', () => {
      expect(distribution.body).toMatch(/viewer_protocol_policy[ \t]*=[ \t]*"redirect-to-https"/);
    });

    it.each([
      ['Strict-Transport-Security', /strict_transport_security[ \t]*\{/],
      ['X-Content-Type-Options', /content_type_options[ \t]*\{/],
      ['X-Frame-Options', /frame_options[ \t]*\{/],
      ['Referrer-Policy', /referrer_policy[ \t]*\{/],
      ['Content-Security-Policy', /content_security_policy[ \t]*\{/],
      ['Permissions-Policy', /header[ \t]*=[ \t]*"Permissions-Policy"/],
    ])('sets the %s response header', (_name, pattern) => {
      expect(headersPolicy.body).toMatch(pattern);
    });

    it('locks down base-uri, object-src, frame-ancestors and form-action in the CSP', () => {
      const csp = headersPolicy.body;
      expect(csp).toContain(`"base-uri 'self'"`);
      expect(csp).toContain(`"object-src 'none'"`);
      expect(csp).toContain(`"frame-ancestors 'none'"`);
      expect(csp).toContain(`"form-action 'self'"`);
      expect(csp).toContain(`"img-src 'self'"`);
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|data:/);
    });
    it('limits connect-src to the origin of payment_api_url, not the full path', () => {
      const csp = headersPolicy.body;
      expect(csp).toContain(`\${regex("^https://[^/]+", var.payment_api_url)}`);
      expect(csp).not.toMatch(/connect-src 'self' \$\{var\.payment_api_url\}/);
    });

    it('sends the origin secret as X-Origin-Verify from random_password', () => {
      const origins = nestedBlocksOf(distribution.body, 'origin');
      const headers = origins.flatMap((origin) => nestedBlocksOf(origin.body, 'custom_header'));
      const verify = headers.find((header) =>
        /name[ \t]*=[ \t]*"X-Origin-Verify"/.test(header.body),
      );
      expect(verify).toBeDefined();
      expect(verify?.body).toMatch(/value[ \t]*=[ \t]*random_password\.origin_verify\.result/);
    });
    it('sets a 30 s origin read timeout on the Lambda origin, above the 25 s Lambda timeout', () => {
      const lambda = findBlock(resourcesOf('aws_lambda_function'), 'api');
      const lambdaTimeout = numericAttribute(topLevel(lambda.body), 'timeout');
      const origins = nestedBlocksOf(distribution.body, 'origin');
      const lambdaOrigin = origins.find((origin) =>
        /origin_id[ \t]*=[ \t]*local\.lambda_origin_id/.test(origin.body),
      );
      expect(lambdaOrigin).toBeDefined();
      const customConfig = nestedBlocksOf(lambdaOrigin?.body ?? '', 'custom_origin_config');
      expect(customConfig).toHaveLength(1);
      const readTimeout = numericAttribute(topLevel(customConfig[0].body), 'origin_read_timeout');
      expect(readTimeout).toBe(30);
      expect(readTimeout).toBeGreaterThan(lambdaTimeout);
    });
  });

  describe('Lambda KMS access', () => {
    const policy = parseBlocks(code, 'data').find((block) => block.labels[1] === 'lambda_exec');
    const statements = nestedBlocksOf(policy?.body ?? '', 'statement');
    const decrypt = statements.find((block) => /"DecryptParametersViaSsm"/.test(block.body));

    it('allows kms:Decrypt only through SSM in the provider region', () => {
      expect(decrypt).toBeDefined();
      const body = decrypt?.body ?? '';
      expect(body).toMatch(/actions[ \t]*=[ \t]*\["kms:Decrypt"\]/);
      expect(body).toMatch(
        /resources[ \t]*=[ \t]*\["arn:aws:kms:\$\{data\.aws_region\.current\.region\}:\$\{[^}]+\}:key\/\*"\]/,
      );
      expect(body).toMatch(/test[ \t]*=[ \t]*"StringEquals"/);
      expect(body).toMatch(/variable[ \t]*=[ \t]*"kms:ViaService"/);
      expect(body).toMatch(
        /values[ \t]*=[ \t]*\["ssm\.\$\{data\.aws_region\.current\.region\}\.amazonaws\.com"\]/,
      );
    });

    it('grants no other KMS action', () => {
      const kmsActions = [...code.matchAll(/"(kms:[A-Za-z*]+)"/g)].map((m) => m[1]);
      expect(new Set(kmsActions)).toEqual(new Set(['kms:Decrypt', 'kms:ViaService']));
    });
  });

  describe('web bucket', () => {
    const bucket = findBlock(resourcesOf('aws_s3_bucket'), 'web');
    const policyDoc = findBlock(parseBlocks(code, 'data'), 'web_bucket');

    it('names the bucket with the project name and the account id', () => {
      expect(attribute(bucket.body, 'bucket')).toBe(
        '"${var.project_name}-web-${data.aws_caller_identity.current.account_id}"',
      );
    });

    it('denies every request that does not use TLS', () => {
      const deny = nestedBlocksOf(policyDoc.body, 'statement').find((block) =>
        /effect[ \t]*=[ \t]*"Deny"/.test(block.body),
      );
      expect(deny).toBeDefined();
      const body = deny?.body ?? '';
      expect(body).toMatch(/actions[ \t]*=[ \t]*\["s3:\*"\]/);
      expect(body).toContain('aws_s3_bucket.web.arn');
      expect(body).toContain('"${aws_s3_bucket.web.arn}/*"');
      expect(body).toMatch(/test[ \t]*=[ \t]*"Bool"/);
      expect(body).toMatch(/variable[ \t]*=[ \t]*"aws:SecureTransport"/);
      expect(body).toMatch(/values[ \t]*=[ \t]*\["false"\]/);
    });

    it('keeps the CloudFront OAC read statement', () => {
      expect(policyDoc.body).toMatch(/identifiers[ \t]*=[ \t]*\["cloudfront\.amazonaws\.com"\]/);
      expect(policyDoc.body).toMatch(/variable[ \t]*=[ \t]*"AWS:SourceArn"/);
    });
  });

  describe('variables and SSM', () => {
    it('requires payment_api_url (no default) and validates the https:// prefix', () => {
      const variable = findBlock(parseBlocks(code, 'variable'), 'payment_api_url');
      expect(topLevel(variable.body)).not.toMatch(/^[ \t]*default[ \t]*=/m);
      expect(variable.body).toMatch(/regex\("\^https:\/\/", var\.payment_api_url\)/);
    });

    it('declares budget_notification_email without a default', () => {
      const variable = findBlock(parseBlocks(code, 'variable'), 'budget_notification_email');
      expect(topLevel(variable.body)).not.toMatch(/^[ \t]*default[ \t]*=/m);
    });

    it('marks budget_notification_email as sensitive', () => {
      expect(isSensitiveVariable(codeFiles['variables.tf'], 'budget_notification_email')).toBe(
        true,
      );
    });
    it('detects budget_notification_email without sensitive = true', () => {
      const variables = codeFiles['variables.tf'];
      expect(isSensitiveVariable(variables, 'payment_api_url')).toBe(false);
      const mutated = variables.replace(/^[ \t]*sensitive[ \t]*=[ \t]*true\n/m, '');
      expect(mutated).not.toEqual(variables);
      expect(isSensitiveVariable(mutated, 'budget_notification_email')).toBe(false);
      const falseValue = variables.replace(/sensitive(\s*)= true/, 'sensitive$1= false');
      expect(isSensitiveVariable(falseValue, 'budget_notification_email')).toBe(false);
    });
    it('rotates the origin secret through origin_secret_rotation keepers', () => {
      expect(hasOriginSecretRotation(codeFiles['variables.tf'], codeFiles['ssm.tf'])).toBe(true);
    });
    it('detects an origin secret without the rotation keepers', () => {
      const variables = codeFiles['variables.tf'];
      const ssm = codeFiles['ssm.tf'];
      const withoutKeepers = ssm.replace(/keepers = \{[^}]*\}/, '');
      expect(withoutKeepers).not.toEqual(ssm);
      expect(hasOriginSecretRotation(variables, withoutKeepers)).toBe(false);
      const literalKeepers = ssm.replace('var.origin_secret_rotation', '"1"');
      expect(hasOriginSecretRotation(variables, literalKeepers)).toBe(false);
      const otherDefault = variables.replace(
        /(variable "origin_secret_rotation"[\s\S]*?default\s*=\s*)"1"/,
        '$1"2"',
      );
      expect(otherDefault).not.toEqual(variables);
      expect(hasOriginSecretRotation(otherDefault, ssm)).toBe(false);
    });
    it('generates the origin secret with random_password in ssm.tf and sets no key_id', () => {
      const ssm = codeFiles['ssm.tf'] ?? '';
      expect(findBlock(resourcesOf('random_password', ssm), 'origin_verify')).toBeDefined();
      expect(ssm).not.toMatch(/\bkey_id\b/);
    });

    it('never defines an SSM parameter or data source that touches the payment namespace', () => {
      const ssmBlocks = [...parseBlocks(code, 'resource'), ...parseBlocks(code, 'data')].filter(
        (block) => block.labels[0] === 'aws_ssm_parameter',
      );
      expect(ssmBlocks.length).toBeGreaterThan(0);
      expect(ssmBlocks.filter((block) => /payment/i.test(block.body))).toEqual([]);
    });
  });

  describe('secrets and forbidden words', () => {
    it('contains no private key literal (prv_)', () => {
      expect(rawText).not.toMatch(/prv_/);
    });

    const forbiddenIt = WORDS_EXIST ? it : it.skip;
    forbiddenIt('contains no forbidden word in infra/*.tf', () => {
      const words = readForbiddenWords();
      expect(words.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const [name, text] of Object.entries(files)) {
        text.split('\n').forEach((line, index) => {
          const lower = line.toLowerCase();
          if (words.some((word) => lower.includes(word))) {
            offenders.push(`${name}:${index + 1}`);
          }
        });
      }
      expect(offenders).toEqual([]);
    });
  });
});
