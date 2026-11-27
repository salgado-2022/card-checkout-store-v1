import * as fs from 'fs';
import * as path from 'path';

// Static checks on the DynamoDB grants of task 1.14. The Terraform files are read
// as text and never applied.
const repoRoot = path.resolve(__dirname, '../../..');
const lambdaTf = fs.readFileSync(path.resolve(repoRoot, 'infra', 'lambda.tf'), 'utf8');
const bootstrapTf = fs.readFileSync(
  path.resolve(repoRoot, 'infra', 'bootstrap', 'main.tf'),
  'utf8',
);
const deploymentDoc = fs.readFileSync(path.resolve(repoRoot, 'docs', 'deployment.md'), 'utf8');

const PRODUCTS_ARN_BOOTSTRAP =
  'arn:aws:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-products';

// Returns the text of the statement block that starts with the given Sid, up to its closing line.
function blockWithSid(source: string, sid: string): string {
  const index = source.indexOf(`"${sid}"`);
  if (index === -1) {
    return '';
  }
  const start = source.lastIndexOf('{', index);
  // Count braces by depth. Terraform interpolations such as ${var.x} add a balanced pair.
  let depth = 0;
  for (let position = start; position < source.length; position += 1) {
    if (source[position] === '{') {
      depth += 1;
    } else if (source[position] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, position + 1);
      }
    }
  }
  return '';
}

describe('DynamoDB grants for the seed and the Scan (task 1.14)', () => {
  describe('infra/lambda.tf', () => {
    const statement = blockWithSid(lambdaTf, 'ProductsTableScan');

    it('defines the ProductsTableScan statement', () => {
      expect(statement).not.toBe('');
    });

    it('allows dynamodb:Scan and nothing else', () => {
      expect(statement).toMatch(/actions\s*=\s*\["dynamodb:Scan"\]/);
    });

    it('scopes the statement to the products table ARN only', () => {
      expect(statement).toMatch(/resources\s*=\s*\[aws_dynamodb_table\.products\.arn\]/);
    });

    it('never uses an index or a wildcard in the statement', () => {
      expect(statement).not.toContain('index/');
      expect(statement).not.toMatch(/\*"/);
      expect(statement).not.toMatch(/"\*"/);
    });

    it('grants dynamodb:Scan only in this statement', () => {
      expect(lambdaTf.match(/dynamodb:Scan/g)).toHaveLength(1);
    });

    it('keeps the existing TablesAccess statement without Scan', () => {
      const tablesAccess = blockWithSid(lambdaTf, 'TablesAccess');
      expect(tablesAccess).toContain('dynamodb:Query');
      expect(tablesAccess).not.toContain('dynamodb:Scan');
    });
  });

  describe('infra/bootstrap/main.tf', () => {
    it('adds ProductsTableScan to the Lambda permissions boundary with the literal products ARN', () => {
      const statement = blockWithSid(bootstrapTf, 'ProductsTableScan');
      expect(statement).toMatch(/Action\s*=\s*\["dynamodb:Scan"\]/);
      expect(statement).toContain(`Resource = "${PRODUCTS_ARN_BOOTSTRAP}"`);
      expect(statement).not.toContain('index/');
      expect(statement).not.toMatch(/"\*"/);
    });

    it('adds ProductsTableSeedItems to the deploy role with exactly three item actions', () => {
      const statement = blockWithSid(bootstrapTf, 'ProductsTableSeedItems');
      expect(statement).toMatch(
        /Action\s*=\s*\["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem"\]/,
      );
      expect(statement).toContain(`Resource = "${PRODUCTS_ARN_BOOTSTRAP}"`);
      expect(statement).not.toContain('index/');
      expect(statement).not.toMatch(/"\*"/);
    });

    it('keeps the seed item actions out of the existing DynamoDb statement', () => {
      const dynamoDbStatement = blockWithSid(bootstrapTf, 'DynamoDb');
      expect(dynamoDbStatement).not.toContain('dynamodb:PutItem');
      expect(dynamoDbStatement).not.toContain('dynamodb:GetItem');
      expect(dynamoDbStatement).not.toContain('dynamodb:DeleteItem');
      expect(dynamoDbStatement).not.toContain('dynamodb:Scan');
    });

    it('grants the item actions only in ProductsTableSeedItems and the pre-existing boundary TablesAccess', () => {
      const existingBoundaryTablesAccess = blockWithSid(bootstrapTf, 'TablesAccess');
      const seedItems = blockWithSid(bootstrapTf, 'ProductsTableSeedItems');
      const productsScan = blockWithSid(bootstrapTf, 'ProductsTableScan');
      const remainder = bootstrapTf
        .replace(existingBoundaryTablesAccess, '')
        .replace(seedItems, '')
        .replace(productsScan, '');
      expect(remainder).not.toMatch(/dynamodb:(PutItem|GetItem|DeleteItem|Scan)/);
      expect(bootstrapTf.match(/dynamodb:Scan/g)).toHaveLength(1);
    });
  });

  describe('docs/deployment.md', () => {
    it('explains the one-time bootstrap re-apply', () => {
      expect(deploymentDoc).toContain('dynamodb:Scan');
      expect(deploymentDoc).toContain('PutItem');
      expect(deploymentDoc).toContain('infra/bootstrap');
      expect(deploymentDoc).toMatch(/terraform apply \\\s+-var/);
    });
  });
});

describe('CloudFront grants for the custom /api/* origin request policy', () => {
  const cloudFront = blockWithSid(bootstrapTf, 'CloudFront');

  it.each([
    'cloudfront:CreateOriginRequestPolicy',
    'cloudfront:GetOriginRequestPolicy',
    'cloudfront:GetOriginRequestPolicyConfig',
    'cloudfront:UpdateOriginRequestPolicy',
    'cloudfront:DeleteOriginRequestPolicy',
    'cloudfront:ListOriginRequestPolicies',
  ])('lets the deploy role manage the policy with %s', (action) => {
    expect(cloudFront).toContain(`"${action}"`);
  });
});
