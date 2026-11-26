import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const readmePath = path.resolve(repoRoot, 'README.md');
const pullRequestTemplatePath = path.resolve(repoRoot, '.github', 'pull_request_template.md');
const workflowsTemplatePath = path.resolve(repoRoot, '.github', 'workflows', 'pull_request_template.md');

describe('repository documentation (task 1.3)', () => {
  describe('README.md', () => {
    const readme = fs.readFileSync(readmePath, 'utf8');

    it.each([
      'npm run lint',
      'npx tsc --noEmit',
      'npm test -- --coverage',
      'npm run build',
    ])('mentions the command "%s"', (command) => {
      expect(readme).toContain(command);
    });
  });

  describe('.github/pull_request_template.md', () => {
    it('exists', () => {
      expect(fs.existsSync(pullRequestTemplatePath)).toBe(true);
    });

    it('asks for the user story id', () => {
      const template = fs.readFileSync(pullRequestTemplatePath, 'utf8');
      expect(template).toMatch(/HU-xx/);
    });

    it('lists the quality gates', () => {
      const template = fs.readFileSync(pullRequestTemplatePath, 'utf8');
      expect(template.toLowerCase()).toContain('quality gates');
    });
  });

  it('has no pull request template under .github/workflows/', () => {
    expect(fs.existsSync(workflowsTemplatePath)).toBe(false);
  });
});
