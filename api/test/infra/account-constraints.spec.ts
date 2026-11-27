import * as fs from 'fs';
import * as path from 'path';

// Account constraints (managed SCPs): regional resources live in us-east-2 only and the
// GitHub OIDC provider already exists, so Terraform never declares or reads it.
const INFRA_DIR = path.resolve(__dirname, '../../../infra');
const ALLOWED_REGION = 'us-east-2';
const DENIED_REGION = 'us-east-1';

function terraformFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '.terraform' ? [] : terraformFiles(full);
    }
    return entry.name.endsWith('.tf') || entry.name === 'README.md' ? [full] : [];
  });
}

const files = terraformFiles(INFRA_DIR).map((file) => ({
  name: path.relative(INFRA_DIR, file),
  text: fs.readFileSync(file, 'utf8'),
}));

// Lines that are not full-line comments: comments may explain the restriction.
function codeLines(text: string): string[] {
  return text.split('\n').filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith('#') && !trimmed.startsWith('//');
  });
}

describe('infra account constraints (static)', () => {
  it('reads the Terraform files of infra/ and infra/bootstrap/', () => {
    const names = files.map((file) => file.name);
    expect(names).toEqual(expect.arrayContaining(['providers.tf', 'bootstrap/main.tf']));
  });

  it('keeps Terraform code free of the denied region outside comments', () => {
    const offenders = files
      .filter((file) => file.name.endsWith('.tf'))
      .filter((file) => codeLines(file.text).some((line) => line.includes(DENIED_REGION)))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it('keeps infra/README.md free of the denied region', () => {
    const readme = files.find((file) => file.name === 'README.md');
    expect(readme?.text).not.toContain(DENIED_REGION);
  });

  it('allows the denied region only inside comments that explain the restriction', () => {
    for (const file of files.filter((f) => f.name.endsWith('.tf'))) {
      const comments = file.text
        .split('\n')
        .filter((line) => line.includes(DENIED_REGION))
        .filter((line) => line.trimStart().startsWith('#'));
      for (const comment of comments) {
        expect(comment.toLowerCase()).toMatch(/denied|restriction|scp/);
      }
    }
  });

  it('writes the allowed region literal only in the two provider blocks', () => {
    const withLiteral = files
      .filter((file) => file.name.endsWith('.tf'))
      .filter((file) => codeLines(file.text).some((line) => line.includes(ALLOWED_REGION)))
      .map((file) => file.name)
      .sort();
    expect(withLiteral).toEqual(['bootstrap/main.tf', 'providers.tf']);
  });

  it('never declares or reads an IAM OIDC provider (resource or data source)', () => {
    for (const file of files.filter((f) => f.name.endsWith('.tf'))) {
      expect({ file: file.name, found: /aws_iam_openid_connect_provider/.test(file.text) }).toEqual(
        { file: file.name, found: false },
      );
      expect({ file: file.name, imported: /^\s*import\s*{/m.test(file.text) }).toEqual({
        file: file.name,
        imported: false,
      });
    }
  });
});
