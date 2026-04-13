export type ReviewJudgeDecisionV1 = {
  schema_version: 1;
  disposition: 'request_evidence_search' | 'accept';
  reason: string;
  query?: string;
  target_evidence_node_id?: string;
};

export type ReviewJudgeDecisionParseIssue = {
  path: string;
  message: string;
};

type ParseSuccess = { ok: true; value: ReviewJudgeDecisionV1 };
type ParseFailure = { ok: false; issues: ReviewJudgeDecisionParseIssue[] };

function issue(path: string, message: string): ReviewJudgeDecisionParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function safeParseReviewJudgeDecisionV1(value: unknown): ParseSuccess | ParseFailure {
  const issues: ReviewJudgeDecisionParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.schema_version !== 1) {
    issues.push(issue('schema_version', 'must equal 1'));
  }
  if (value.disposition !== 'request_evidence_search' && value.disposition !== 'accept') {
    issues.push(issue('disposition', 'must be request_evidence_search or accept'));
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    issues.push(issue('reason', 'must be a non-empty string'));
  }
  if (value.disposition === 'request_evidence_search') {
    if (typeof value.query !== 'string' || value.query.trim().length === 0) {
      issues.push(issue('query', 'must be a non-empty string when disposition=request_evidence_search'));
    }
    if (
      typeof value.target_evidence_node_id !== 'string'
      || value.target_evidence_node_id.trim().length === 0
    ) {
      issues.push(issue(
        'target_evidence_node_id',
        'must be a non-empty string when disposition=request_evidence_search',
      ));
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as ReviewJudgeDecisionV1 };
}

export function parseReviewJudgeDecisionV1(value: unknown): ReviewJudgeDecisionV1 {
  const parsed = safeParseReviewJudgeDecisionV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
