import type {
  ArtifactRefV1,
  WritingReviewBridgeV1,
} from './generated/index.js';

export type WritingReviewBridgeParseIssue = {
  path: string;
  message: string;
};

type ParseSuccess = { ok: true; value: WritingReviewBridgeV1 };
type ParseFailure = { ok: false; issues: WritingReviewBridgeParseIssue[] };

function issue(path: string, message: string): WritingReviewBridgeParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validateArtifactRef(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): value is ArtifactRefV1 {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return false;
  }
  if (typeof value.uri !== 'string' || value.uri.length === 0) {
    issues.push(issue(`${path}.uri`, 'must be a non-empty string'));
  }
  if (typeof value.sha256 !== 'string' || value.sha256.length === 0) {
    issues.push(issue(`${path}.sha256`, 'must be a non-empty string'));
  }
  return issues.length === 0 || !issues.some(entry => entry.path.startsWith(path));
}

function validateArtifactRefArray(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): value is ArtifactRefV1[] {
  if (!Array.isArray(value)) {
    issues.push(issue(path, 'must be an array'));
    return false;
  }
  value.forEach((item, index) => {
    validateArtifactRef(item, `${path}[${index}]`, issues);
  });
  return true;
}

function validateVerificationRefs(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object when provided'));
    return false;
  }
  for (const bucket of ['subject_refs', 'check_run_refs', 'subject_verdict_refs', 'coverage_refs'] as const) {
    if (value[bucket] !== undefined) {
      validateArtifactRefArray(value[bucket], `${path}.${bucket}`, issues);
    }
  }
  return true;
}

function validateSeedPayload(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): boolean {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return false;
  }
  for (const field of ['computation_result_uri', 'manifest_uri', 'summary'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      issues.push(issue(`${path}.${field}`, 'must be a non-empty string'));
    }
  }
  if (!isStringArray(value.produced_artifact_uris)) {
    issues.push(issue(`${path}.produced_artifact_uris`, 'must be an array of strings'));
  }
  if (value.finding_node_ids !== undefined && !isStringArray(value.finding_node_ids)) {
    issues.push(issue(`${path}.finding_node_ids`, 'must be an array of strings when provided'));
  }
  for (const field of ['draft_node_id', 'issue_node_id', 'target_draft_node_id', 'source_artifact_name'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      issues.push(issue(`${path}.${field}`, 'must be a string when provided'));
    }
  }
  if (
    value.source_content_type !== undefined
    && value.source_content_type !== 'section_output'
    && value.source_content_type !== 'reviewer_report'
    && value.source_content_type !== 'revision_plan'
  ) {
    issues.push(issue(`${path}.source_content_type`, 'must be section_output, reviewer_report, or revision_plan when provided'));
  }
  return true;
}

function validateTarget(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): boolean {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return false;
  }
  if (value.task_kind !== 'draft_update' && value.task_kind !== 'review') {
    issues.push(issue(`${path}.task_kind`, 'must be draft_update or review'));
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    issues.push(issue(`${path}.title`, 'must be a non-empty string'));
  }
  if (typeof value.target_node_id !== 'string' || value.target_node_id.length === 0) {
    issues.push(issue(`${path}.target_node_id`, 'must be a non-empty string'));
  }
  if (
    value.suggested_content_type !== 'section_output'
    && value.suggested_content_type !== 'reviewer_report'
    && value.suggested_content_type !== 'revision_plan'
  ) {
    issues.push(issue(`${path}.suggested_content_type`, 'must be section_output, reviewer_report, or revision_plan'));
  }
  validateSeedPayload(value.seed_payload, `${path}.seed_payload`, issues);
  return true;
}

function validateHandoff(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object when provided'));
    return false;
  }
  if (value.handoff_kind !== 'writing' && value.handoff_kind !== 'review') {
    issues.push(issue(`${path}.handoff_kind`, 'must be writing or review'));
  }
  if (typeof value.target_node_id !== 'string' || value.target_node_id.length === 0) {
    issues.push(issue(`${path}.target_node_id`, 'must be a non-empty string'));
  }
  if (!isObject(value.payload)) {
    issues.push(issue(`${path}.payload`, 'must be an object'));
    return false;
  }
  return true;
}

function validateContext(
  value: unknown,
  path: string,
  issues: WritingReviewBridgeParseIssue[],
): boolean {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return false;
  }
  if (value.draft_context_mode !== 'seeded_draft' && value.draft_context_mode !== 'existing_draft') {
    issues.push(issue(`${path}.draft_context_mode`, 'must be seeded_draft or existing_draft'));
  }
  for (const field of [
    'draft_source_artifact_name',
    'draft_source_content_type',
    'review_source_artifact_name',
    'review_source_content_type',
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      issues.push(issue(`${path}.${field}`, 'must be a string when provided'));
    }
  }
  return true;
}

export function safeParseWritingReviewBridgeV1(value: unknown): ParseSuccess | ParseFailure {
  const issues: WritingReviewBridgeParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }

  if (value.schema_version !== 1) {
    issues.push(issue('schema_version', 'must equal 1'));
  }
  if (value.bridge_kind !== 'writing' && value.bridge_kind !== 'review') {
    issues.push(issue('bridge_kind', 'must be writing or review'));
  }
  for (const field of ['run_id', 'objective_title', 'summary', 'computation_result_uri'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      issues.push(issue(field, 'must be a non-empty string'));
    }
  }

  validateArtifactRef(value.manifest_ref, 'manifest_ref', issues);
  validateArtifactRefArray(value.produced_artifact_refs, 'produced_artifact_refs', issues);
  validateVerificationRefs(value.verification_refs, 'verification_refs', issues);
  validateTarget(value.target, 'target', issues);
  validateHandoff(value.handoff, 'handoff', issues);
  validateContext(value.context, 'context', issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as unknown as WritingReviewBridgeV1 };
}

export function parseWritingReviewBridgeV1(value: unknown): WritingReviewBridgeV1 {
  const parsed = safeParseWritingReviewBridgeV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
