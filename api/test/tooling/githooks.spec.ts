import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const COMMIT_MSG_HOOK = path.resolve(__dirname, '../../../.githooks/commit-msg');
const FAKE_FORBIDDEN_WORD = 'acmepay';

describe('.githooks/commit-msg', () => {
  let tempDir: string;
  let forbiddenListPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'githooks-'));
    forbiddenListPath = path.join(tempDir, 'forbidden-words.txt');
    fs.writeFileSync(forbiddenListPath, `${FAKE_FORBIDDEN_WORD}\n`);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runHook(message: string, wordsFile: string = forbiddenListPath): number | null {
    const msgPath = path.join(tempDir, `msg-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(msgPath, message);
    const result = spawnSync(COMMIT_MSG_HOOK, [msgPath], {
      env: { ...process.env, FORBIDDEN_WORDS_FILE: wordsFile },
      encoding: 'utf8',
    });
    return result.status;
  }

  it('is executable', () => {
    const mode = fs.statSync(COMMIT_MSG_HOOK).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it.each([
    'feat(api): add health',
    'chore: setup',
    'fix(web): handle empty cart',
    'feat!: drop v1',
  ])('accepts the Conventional Commit "%s"', (message) => {
    expect(runHook(message)).toBe(0);
  });

  it.each(['added stuff', '', 'feat add health', 'unknown(api): x', 'feat:'])(
    'rejects the invalid message "%s"',
    (message) => {
      expect(runHook(message)).not.toBe(0);
    },
  );

  it('ignores comment and blank lines before the subject', () => {
    expect(runHook('# Please enter the commit message\n\nfeat: add health\n')).toBe(0);
  });

  it('rejects a message whose subject contains a forbidden word', () => {
    expect(runHook(`feat: add ${FAKE_FORBIDDEN_WORD} adapter`)).not.toBe(0);
  });

  it('matches forbidden words regardless of letter case', () => {
    expect(runHook(`feat: add ${FAKE_FORBIDDEN_WORD.toUpperCase()} adapter`)).not.toBe(0);
  });

  it('does not reject a Conventional Commit when the forbidden word is absent', () => {
    expect(runHook('feat: add health check')).toBe(0);
  });

  it('skips the word check when the word list does not exist', () => {
    const missing = path.join(tempDir, 'does-not-exist.txt');
    expect(runHook(`feat: add ${FAKE_FORBIDDEN_WORD} adapter`, missing)).toBe(0);
  });

  it('fails when no message file is given', () => {
    const result = spawnSync(COMMIT_MSG_HOOK, [], {
      env: { ...process.env, FORBIDDEN_WORDS_FILE: forbiddenListPath },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
  });
});
