import { describe, expect, it } from 'vitest';

import {
  parseStagedContentArtifactV1,
  safeParseStagedContentArtifactV1,
} from '../staged-content.js';

describe('staged-content runtime parser', () => {
  it('accepts a minimal valid staged content artifact', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'section_output',
      content: '{"title":"Draft"}',
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects an unsupported content_type', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'draft',
      content: '{}',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'content_type' })]),
    );
  });

  it('rejects missing content', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'reviewer_report',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'content' })]),
    );
  });

  it('rejects invalid version', () => {
    expect(() => parseStagedContentArtifactV1({
      version: 2,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'reviewer_report',
      content: '{}',
    })).toThrow(/version/);
  });

  it('rejects non-string content', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'revision_plan',
      content: { foo: 'bar' },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'content' })]),
    );
  });

  it('accepts a task-scoped draft_update staged artifact', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'section_output',
      content: '{"title":"Draft"}',
      task_ref: {
        task_id: 'task-draft-1',
        task_kind: 'draft_update',
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a task-scoped review staged artifact', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'reviewer_report',
      content: '{"summary":"Review"}',
      task_ref: {
        task_id: 'task-review-1',
        task_kind: 'review',
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a task-scoped review judge_decision artifact', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'judge_decision',
      content: '{"schema_version":1,"disposition":"accept","reason":"ok"}',
      task_ref: {
        task_id: 'task-review-1',
        task_kind: 'review',
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects partial task_ref provenance', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'section_output',
      content: '{}',
      task_ref: {
        task_id: 'task-draft-1',
      },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'task_ref.task_kind' })]),
    );
  });

  it('rejects draft_update provenance on reviewer_report artifacts', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'reviewer_report',
      content: '{}',
      task_ref: {
        task_id: 'task-draft-1',
        task_kind: 'draft_update',
      },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'task_ref.task_kind' })]),
    );
  });

  it('rejects review provenance on section_output artifacts', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'section_output',
      content: '{}',
      task_ref: {
        task_id: 'task-review-1',
        task_kind: 'review',
      },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'task_ref.task_kind' })]),
    );
  });

  it('rejects draft_update provenance on judge_decision artifacts', () => {
    const parsed = safeParseStagedContentArtifactV1({
      version: 1,
      staged_at: '2026-04-13T00:00:00Z',
      content_type: 'judge_decision',
      content: '{"schema_version":1,"disposition":"accept","reason":"ok"}',
      task_ref: {
        task_id: 'task-draft-1',
        task_kind: 'draft_update',
      },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'task_ref.task_kind' })]),
    );
  });
});
