export type StagedContentType =
  | 'section_output'
  | 'outline_plan'
  | 'paperset_curation'
  | 'revision_plan'
  | 'reviewer_report'
  | 'judge_decision';

export type StagedContentArtifactV1 = {
  version: 1;
  staged_at: string;
  content_type: StagedContentType;
  content: string;
  task_ref?: {
    task_id: string;
    task_kind: 'draft_update' | 'review';
  };
};

export type StagedContentParseIssue = {
  path: string;
  message: string;
};

type ParseSuccess = { ok: true; value: StagedContentArtifactV1 };
type ParseFailure = { ok: false; issues: StagedContentParseIssue[] };

function issue(path: string, message: string): StagedContentParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStagedContentType(value: unknown): value is StagedContentType {
  return value === 'section_output'
    || value === 'outline_plan'
    || value === 'paperset_curation'
    || value === 'revision_plan'
    || value === 'reviewer_report'
    || value === 'judge_decision';
}

export function safeParseStagedContentArtifactV1(value: unknown): ParseSuccess | ParseFailure {
  const issues: StagedContentParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.version !== 1) {
    issues.push(issue('version', 'must equal 1'));
  }
  if (typeof value.staged_at !== 'string' || value.staged_at.length === 0) {
    issues.push(issue('staged_at', 'must be a non-empty string'));
  }
  if (!isStagedContentType(value.content_type)) {
    issues.push(issue('content_type', 'must be a supported staged content type'));
  }
  if (typeof value.content !== 'string') {
    issues.push(issue('content', 'must be a string'));
  }
  const taskRef = value.task_ref;
  if (taskRef !== undefined) {
    if (!isObject(taskRef)) {
      issues.push(issue('task_ref', 'must be an object when provided'));
    } else {
      const taskId = taskRef.task_id;
      const taskKind = taskRef.task_kind;
      const hasTaskId = typeof taskId === 'string' && taskId.length > 0;
      const hasTaskKind = taskKind === 'draft_update' || taskKind === 'review';
      if (hasTaskId !== hasTaskKind) {
        if (!hasTaskId) issues.push(issue('task_ref.task_id', 'must be a non-empty string when task_kind is provided'));
        if (!hasTaskKind) issues.push(issue('task_ref.task_kind', 'must be draft_update or review when task_id is provided'));
      }
      if (hasTaskKind && value.content_type) {
        if (taskKind === 'draft_update' && value.content_type !== 'section_output') {
          issues.push(issue('task_ref.task_kind', 'draft_update outputs must use section_output'));
        }
        if (
          taskKind === 'review'
          && value.content_type !== 'reviewer_report'
          && value.content_type !== 'revision_plan'
          && value.content_type !== 'judge_decision'
        ) {
          issues.push(issue('task_ref.task_kind', 'review outputs must use reviewer_report, revision_plan, or judge_decision'));
        }
      }
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as unknown as StagedContentArtifactV1 };
}

export function parseStagedContentArtifactV1(value: unknown): StagedContentArtifactV1 {
  const parsed = safeParseStagedContentArtifactV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
