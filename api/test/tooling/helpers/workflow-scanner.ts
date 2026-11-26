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
