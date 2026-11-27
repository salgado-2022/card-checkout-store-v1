// Pure line-based scanner for GitHub Actions workflow text. Each rule is a regular
// expression applied to every line; a line that matches reports one violation.
// Used by the ci.yml isolation test (Property 14) and reusable for other workflows.

export interface WorkflowRule {
  readonly id: string;
  readonly pattern: RegExp;
}

export interface WorkflowViolation {
  readonly rule: string;
  // 1-based line number in the scanned text.
  readonly line: number;
}

// Rule set for ci.yml (Requirements 5.8, 5.9, 5.10). Matching is case-insensitive.
export const CI_FORBIDDEN_RULES: readonly WorkflowRule[] = [
  { id: 'secrets-expression', pattern: /secrets\./i },
  { id: 'aws-action', pattern: /aws-actions\//i },
  { id: 'id-token-permission', pattern: /id-token/i },
  { id: 'aws-variable', pattern: /aws_/i },
  { id: 'terraform-command', pattern: /terraform/i },
  // A YAML `environment:` key, either as a block key or inside a flow mapping.
  { id: 'environment-key', pattern: /(?:^\s*(?:-\s+)?|[{,]\s*)["']?environment["']?\s*:/i },
];

// Rule set for every workflow and script (Properties 13, Requirements 15.5, 15.6, 15.7,
// 20.10, 21.5, 21.13). No destroy and no long-lived AWS credentials. Matching is case-insensitive
// except for the AKIA access key format, which AWS issues in upper case only.
export const NO_DESTROY_NO_KEYS_RULES: readonly WorkflowRule[] = [
  { id: 'terraform-destroy', pattern: /terraform\s+destroy/i },
  { id: 'destroy-flag', pattern: /-destroy/i },
  { id: 'aws-access-key-id-input', pattern: /aws-access-key-id/i },
  { id: 'aws-access-key-id-variable', pattern: /AWS_ACCESS_KEY_ID/i },
  { id: 'aws-secret-access-key', pattern: /AWS_SECRET_ACCESS_KEY/i },
  { id: 'long-lived-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
];

// Rule applied only to deploy.yml: the workflow must not read secrets from `secrets.`.
export const DEPLOY_ONLY_RULES: readonly WorkflowRule[] = [
  { id: 'secrets-expression', pattern: /secrets\./i },
];

export function scanWorkflow(text: string, rules: readonly WorkflowRule[]): WorkflowViolation[] {
  const violations: WorkflowViolation[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      // String.prototype.search ignores the `g` and `y` flags, so a shared RegExp
      // cannot carry a stale lastIndex from one call to the next.
      if (line.search(rule.pattern) !== -1) {
        violations.push({ rule: rule.id, line: index + 1 });
      }
    }
  });
  return violations;
}
