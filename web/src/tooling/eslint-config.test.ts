/**
 * @jest-environment node
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

interface LintMessage {
  ruleId: string | null;
  severity: number;
}

const webRoot = path.resolve(__dirname, '..', '..');
const filePath = path.join(webRoot, 'src', 'tooling', 'snippet.ts');

// Jest cannot load the ESLint flat config (ESLint imports it with a native dynamic import, which
// Jest rejects without --experimental-vm-modules). The ESLint Node API therefore runs in a child
// Node process. The snippet goes through stdin and the messages come back as JSON on stdout.
const LINT_SCRIPT = `
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
const [cwd, file] = process.argv.slice(1);
const eslint = new ESLint({ cwd });
const [result] = await eslint.lintText(readFileSync(0, 'utf8'), { filePath: file });
const messages = result.messages.map((m) => ({ ruleId: m.ruleId, severity: m.severity }));
process.stdout.write(JSON.stringify(messages));
`;

function lint(snippet: string): LintMessage[] {
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', LINT_SCRIPT, webRoot, filePath],
    { cwd: webRoot, input: snippet, encoding: 'utf8' },
  );
  return JSON.parse(stdout) as LintMessage[];
}

describe('web ESLint configuration', () => {
  it('reports a Prettier error for a badly formatted snippet', () => {
    const messages = lint('const a = {b:"x"}\n');

    const prettierErrors = messages.filter((m) => m.ruleId === 'prettier/prettier');
    expect(prettierErrors).toHaveLength(1);
    expect(prettierErrors[0].severity).toBe(2);
  });

  it('reports no messages for a snippet formatted with the project Prettier rules', () => {
    expect(lint("export const a = { b: 'x' };\n")).toEqual([]);
  });

  it('reports the typescript-eslint explicit any rule', () => {
    const ruleIds = lint('export const value: any = 1;\n').map((m) => m.ruleId);

    expect(ruleIds).toContain('@typescript-eslint/no-explicit-any');
  });
});
