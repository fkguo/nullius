import { describe, expect, it } from 'vitest';

import {
  parseWritingReviewBridgeV1,
  safeParseWritingReviewBridgeV1,
} from '../writing-review-bridge.js';

function makeArtifactRef(uri = 'rep://runs/run-1/artifacts/task_001.json') {
  return {
    uri,
    sha256: 'a'.repeat(64),
  };
}

function makeBridge(kind: 'writing' | 'review') {
  return {
    schema_version: 1,
    bridge_kind: kind,
    run_id: 'run-1',
    objective_title: 'Bridge parse test',
    feedback_signal: 'success',
    decision_kind: 'capture_finding',
    summary: 'summary',
    computation_result_uri: 'rep://runs/run-1/artifacts/computation_result_v1.json',
    manifest_ref: makeArtifactRef('rep://runs/run-1/computation/manifest.json'),
    produced_artifact_refs: [makeArtifactRef()],
    verification_refs: {
      subject_refs: [makeArtifactRef('rep://runs/run-1/artifacts/verification_subject.json')],
    },
    target: {
      task_kind: kind === 'writing' ? 'draft_update' : 'review',
      title: 'Task title',
      target_node_id: kind === 'writing' ? 'draft-node' : 'review-node',
      suggested_content_type: kind === 'writing' ? 'section_output' : 'reviewer_report',
      seed_payload: {
        computation_result_uri: 'rep://runs/run-1/artifacts/computation_result_v1.json',
        manifest_uri: 'rep://runs/run-1/computation/manifest.json',
        summary: 'summary',
        produced_artifact_uris: ['rep://runs/run-1/artifacts/task_001.json'],
        ...(kind === 'writing'
          ? { finding_node_ids: ['finding-1'], draft_node_id: 'draft-node' }
          : { issue_node_id: 'review-node', target_draft_node_id: 'draft-node', source_artifact_name: 'staged_section_output_latest.json' }),
      },
    },
    ...(kind === 'review'
      ? {
          handoff: {
            handoff_kind: 'review',
            target_node_id: 'review-node',
            payload: {
              issue_node_id: 'review-node',
              target_draft_node_id: 'draft-node',
            },
          },
        }
      : {}),
    context: {
      draft_context_mode: kind === 'writing' ? 'seeded_draft' : 'existing_draft',
      ...(kind === 'review'
        ? {
            draft_source_artifact_name: 'staged_section_output_latest.json',
            draft_source_content_type: 'section_output',
          }
        : {}),
    },
  };
}

describe('WritingReviewBridgeV1 runtime parser', () => {
  it('accepts a minimal valid writing bridge', () => {
    const parsed = safeParseWritingReviewBridgeV1(makeBridge('writing'));
    expect(parsed.ok).toBe(true);
  });

  it('accepts a minimal valid review bridge', () => {
    const parsed = safeParseWritingReviewBridgeV1(makeBridge('review'));
    expect(parsed.ok).toBe(true);
  });

  it('rejects missing target.task_kind', () => {
    const bridge = makeBridge('writing');
    delete bridge.target.task_kind;
    const parsed = safeParseWritingReviewBridgeV1(bridge);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'target.task_kind' })]),
    );
  });

  it('rejects missing target.target_node_id', () => {
    const bridge = makeBridge('review');
    delete bridge.target.target_node_id;
    expect(() => parseWritingReviewBridgeV1(bridge)).toThrow(/target\.target_node_id/);
  });

  it('rejects non-array produced_artifact_refs', () => {
    const bridge = makeBridge('writing');
    // @ts-expect-error test invalid runtime shape
    bridge.produced_artifact_refs = { uri: 'rep://runs/run-1/artifacts/task_001.json' };
    const parsed = safeParseWritingReviewBridgeV1(bridge);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'produced_artifact_refs' })]),
    );
  });

  it('rejects invalid verification_refs bucket shape', () => {
    const bridge = makeBridge('writing');
    // @ts-expect-error test invalid runtime shape
    bridge.verification_refs = { coverage_refs: { uri: 'rep://runs/run-1/artifacts/coverage.json' } };
    expect(() => parseWritingReviewBridgeV1(bridge)).toThrow(/verification_refs\.coverage_refs/);
  });

  it('rejects invalid context.draft_context_mode', () => {
    const bridge = makeBridge('review');
    // @ts-expect-error test invalid runtime shape
    bridge.context.draft_context_mode = 'future_draft';
    const parsed = safeParseWritingReviewBridgeV1(bridge);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'context.draft_context_mode' })]),
    );
  });
});
