export interface ValidationIssue {
  path: string;
  message: string;
  keyword?: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  issues: ValidationIssue[];
}

export function validationSuccess<T>(data: T): ValidationResult<T> {
  return { ok: true, data, issues: [] };
}

export function validationFailure<T = never>(issues: ValidationIssue[]): ValidationResult<T> {
  return { ok: false, issues };
}

export function prefixIssues(prefix: string, issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path: `${prefix}${issue.path}`.replace(/\/+/g, '/'),
  }));
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ');
}
