import * as path from 'path';
import { spawn } from 'child_process';

// ESLint loads eslint.config.mjs with a dynamic import, which Jest does not support
// without --experimental-vm-modules. The ESLint Node API therefore runs in a child Node
// process started from the api/ root, so the real flat config is loaded.
const apiRoot = path.resolve(__dirname, '../..');
const NO_EXPLICIT_ANY = '@typescript-eslint/no-explicit-any';
const PRETTIER_RULE = 'prettier/prettier';

const LINT_SCRIPT = `
const { ESLint } = require('eslint');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const { filePath, source } = JSON.parse(input);
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(source, { filePath });
  process.stdout.write(JSON.stringify(result.messages));
});
`;

interface LintMessage {
  readonly ruleId: string | null;
  readonly severity: number;
}

function lintInChildProcess(filePath: string, source: string): Promise<LintMessage[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', LINT_SCRIPT], { cwd: apiRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ESLint child process exited with ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as LintMessage[]);
    });
    child.stdin.end(JSON.stringify({ filePath: path.join(apiRoot, filePath), source }));
  });
}

const anySource = 'export function read(value: any): any {\n  return value;\n}\n';
const wellFormattedSource = "export const label = 'ok';\n";
const badlyFormattedSource = 'export const label = "ok"\n';

describe('api ESLint configuration (task 2.2)', () => {
  jest.setTimeout(60_000);

  it('reports an error for explicit any inside src/domain', async () => {
    const messages = await lintInChildProcess('src/domain/money.ts', anySource);
    const anyErrors = messages.filter((message) => message.ruleId === NO_EXPLICIT_ANY);

    expect(anyErrors.length).toBeGreaterThan(0);
    expect(anyErrors.every((message) => message.severity === 2)).toBe(true);
  });

  it('does not report no-explicit-any for the same code outside src/domain', async () => {
    const messages = await lintInChildProcess(
      'src/infrastructure/http/health.controller.ts',
      anySource,
    );

    expect(messages.some((message) => message.ruleId === NO_EXPLICIT_ANY)).toBe(false);
  });

  it('reports a Prettier formatting error for a badly formatted snippet', async () => {
    const messages = await lintInChildProcess('src/application/label.ts', badlyFormattedSource);
    const prettierErrors = messages.filter((message) => message.ruleId === PRETTIER_RULE);

    expect(prettierErrors.length).toBeGreaterThan(0);
    expect(prettierErrors.every((message) => message.severity === 2)).toBe(true);
  });

  it('accepts a well-formatted snippet without Prettier errors', async () => {
    const messages = await lintInChildProcess('src/application/label.ts', wellFormattedSource);

    expect(messages.some((message) => message.ruleId === PRETTIER_RULE)).toBe(false);
  });
});
