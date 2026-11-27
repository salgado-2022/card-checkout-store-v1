import * as fs from 'fs';
import * as path from 'path';

// Static checks over the Terraform text of infra/bootstrap. No terraform binary
// and no AWS calls: the tests read the .tf files and match their structure.

const BOOTSTRAP_DIR = path.resolve(__dirname, '../../../infra/bootstrap');

function readBootstrapCode(): string {
  const files = fs
    .readdirSync(BOOTSTRAP_DIR)
    .filter((name) => name.endsWith('.tf'))
    .sort();
  return files
    .map((name) => fs.readFileSync(path.join(BOOTSTRAP_DIR, name), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

// Returns the text between the braces of the first block whose header matches.
function blockBody(code: string, header: string): string {
  const start = code.indexOf(header);
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
        return code.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unterminated block: ${header}`);
}

const code = readBootstrapCode();

describe('infra/bootstrap state bucket (static)', () => {
  it('declares no backend block, so state stays local', () => {
    expect(code).not.toMatch(/^\s*backend\s+"/m);
  });

  it('pins the AWS provider and uses us-east-1', () => {
    const terraformBlock = blockBody(code, 'terraform {');
    expect(terraformBlock).toMatch(/required_providers\s*{/);
    expect(terraformBlock).toMatch(/source\s*=\s*"hashicorp\/aws"/);
    expect(terraformBlock).toMatch(/version\s*=\s*"~> 6\.0"/);
    expect(blockBody(code, 'provider "aws"')).toMatch(/region\s*=\s*"us-east-1"/);
  });

  it.each(['github_owner', 'github_repo', 'state_bucket_name', 'project_name'])(
    'declares variable %s without a default',
    (name) => {
      const body = blockBody(code, `variable "${name}"`);
      expect(body).toMatch(/type\s*=\s*string/);
      expect(body).not.toMatch(/\bdefault\s*=/);
    },
  );

  it('creates the state bucket with force_destroy = false', () => {
    const body = blockBody(code, 'resource "aws_s3_bucket" "state"');
    expect(body).toMatch(/force_destroy\s*=\s*false/);
    expect(body).toMatch(/bucket\s*=\s*var\.state_bucket_name/);
  });

  it('enables versioning on the state bucket', () => {
    const body = blockBody(code, 'resource "aws_s3_bucket_versioning" "state"');
    expect(body).toMatch(/status\s*=\s*"Enabled"/);
  });

  it('encrypts the state bucket with AES256', () => {
    const body = blockBody(
      code,
      'resource "aws_s3_bucket_server_side_encryption_configuration" "state"',
    );
    expect(body).toMatch(/sse_algorithm\s*=\s*"AES256"/);
  });

  it('blocks all public access with the four flags set to true', () => {
    const body = blockBody(code, 'resource "aws_s3_bucket_public_access_block" "state"');
    for (const flag of [
      'block_public_acls',
      'block_public_policy',
      'ignore_public_acls',
      'restrict_public_buckets',
    ]) {
      expect(body).toMatch(new RegExp(`${flag}\\s*=\\s*true`));
    }
  });

  it('exports state_bucket_name', () => {
    expect(code).toMatch(/output\s+"state_bucket_name"\s*{/);
  });
});

describe('infra/bootstrap contains no secrets or access keys (static)', () => {
  it('has no access keys, IAM users or user access keys', () => {
    expect(code).not.toMatch(/aws_access_key/);
    expect(code).not.toMatch(/aws_iam_user/);
  });

  it('has no secret-like literals', () => {
    expect(code).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(code).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(code).not.toMatch(/\bprv_[A-Za-z0-9]/);
    expect(code).not.toMatch(/secret_access_key/i);
    expect(code).not.toMatch(/\bpassword\s*=/i);
  });
});
