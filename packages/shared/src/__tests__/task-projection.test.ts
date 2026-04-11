import { describe, expect, it } from 'vitest';
import {
  WorkflowTaskArtifactRefSchema,
  WorkflowTaskPreconditionSchema,
  WorkflowTaskProjectionInputSchema,
  WorkflowTaskKindSchema,
  WorkflowStepTaskProjectionSchema,
  buildWorkflowStepTaskProjection,
  deriveWorkflowTaskIntent,
} from '../types/task-projection.js';

describe('WorkflowTaskKindSchema', () => {
  it('accepts supported provider-neutral task kinds', () => {
    expect(WorkflowTaskKindSchema.parse('literature')).toBe('literature');
    expect(WorkflowTaskKindSchema.parse('review')).toBe('review');
  });
});

describe('WorkflowTaskPreconditionSchema', () => {
  it('accepts bounded task-level prerequisites', () => {
    expect(WorkflowTaskPreconditionSchema.parse('project_required')).toBe('project_required');
    expect(WorkflowTaskPreconditionSchema.parse('run_required')).toBe('run_required');
  });
});

describe('WorkflowTaskArtifactRefSchema', () => {
  it('accepts stable task-facing artifact references', () => {
    expect(WorkflowTaskArtifactRefSchema.parse('candidate-paper-set')).toBe('candidate-paper-set');
  });
});

describe('WorkflowTaskProjectionInputSchema', () => {
  it('rejects provider-local execution fields', () => {
    expect(() =>
      WorkflowTaskProjectionInputSchema.parse({
        task_id: 'task-1',
        task_kind: 'literature',
        description: 'Find candidate literature for the topic.',
        tool: 'hep_project_build_evidence',
      }),
    ).toThrow();
  });

  it('requires an explicit canonical task_kind', () => {
    expect(() =>
      WorkflowTaskProjectionInputSchema.parse({
        task_id: 'task-1',
        description: 'Find candidate literature for the topic.',
      }),
    ).toThrow();
  });
});

describe('WorkflowStepTaskProjectionSchema', () => {
  it('validates a minimal provider-neutral task projection', () => {
    const result = WorkflowStepTaskProjectionSchema.parse({
      task_id: 'task-1',
      task_kind: 'literature',
      task_intent: 'literature.search',
      title: 'Search candidate papers',
      description: 'Find candidate literature for the topic.',
      depends_on_task_ids: [],
      required_capabilities: ['supports_keyword_search'],
      expected_artifacts: ['candidate-paper-set'],
      preconditions: ['project_required'],
    });

    expect(result.task_kind).toBe('literature');
    expect(result.expected_artifacts).toEqual(['candidate-paper-set']);
  });

  it('rejects provider-local execution fields', () => {
    expect(() =>
      WorkflowStepTaskProjectionSchema.parse({
        task_id: 'task-1',
        task_kind: 'literature',
        task_intent: 'literature.search',
        title: 'Search candidate papers',
        description: 'Find candidate literature for the topic.',
        depends_on_task_ids: [],
        required_capabilities: [],
        expected_artifacts: [],
        preconditions: [],
        tool: 'hep_project_build_evidence',
      }),
    ).toThrow();

    expect(() =>
      WorkflowStepTaskProjectionSchema.parse({
        task_id: 'task-1',
        task_kind: 'literature',
        task_intent: 'literature.search',
        title: 'Search candidate papers',
        description: 'Find candidate literature for the topic.',
        depends_on_task_ids: [],
        required_capabilities: [],
        expected_artifacts: [],
        preconditions: [],
        provider: 'hep',
        params: {},
        degrade_mode: 'skip_with_reason',
        consumer_hints: { artifact: 'x' },
      }),
    ).toThrow();
  });
});

describe('buildWorkflowStepTaskProjection', () => {
  it('normalizes task semantics in a provider-neutral way', () => {
    const result = buildWorkflowStepTaskProjection({
      task_id: 'discover.seed_search',
      task_kind: 'literature',
      action: 'discover.seed_search',
      description: '  Find candidate literature for the topic.  ',
      required_capabilities: ['supports_keyword_search', 'supports_keyword_search'],
      expected_artifacts: ['candidate-paper-set', 'candidate-paper-set'],
      preconditions: ['project_required', 'project_required'],
    });

    expect(result).toEqual({
      task_id: 'discover.seed_search',
      task_kind: 'literature',
      task_intent: 'discover.seed_search',
      title: 'Discover Seed Search',
      description: 'Find candidate literature for the topic.',
      depends_on_task_ids: [],
      required_capabilities: ['supports_keyword_search'],
      expected_artifacts: ['candidate-paper-set'],
      preconditions: ['project_required'],
    });
  });

  it('keeps task_kind explicit while allowing action-based task_intent', () => {
    const result = buildWorkflowStepTaskProjection({
      task_id: 'build_evidence',
      task_kind: 'evidence_search',
      action: 'materialize.evidence_build',
      description: 'Materialize bounded evidence artifacts from the paper set.',
    });

    expect(result.task_kind).toBe('evidence_search');
    expect(result.task_intent).toBe('materialize.evidence_build');
  });

  it('prefers explicit task intent and title when provided', () => {
    const result = buildWorkflowStepTaskProjection({
      task_id: 'step-1',
      task_kind: 'review',
      task_intent: 'review.paper_set',
      title: 'Review candidate set',
      description: 'Review the candidate paper set.',
      depends_on_task_ids: ['seed-search', 'seed-search'],
      preconditions: ['project_required', 'run_required'],
    });

    expect(result.task_intent).toBe('review.paper_set');
    expect(result.title).toBe('Review candidate set');
    expect(result.depends_on_task_ids).toEqual(['seed-search']);
    expect(result.preconditions).toEqual(['project_required', 'run_required']);
  });
});

describe('task-projection derivation helpers', () => {
  it('prefers explicit task_intent over action', () => {
    const input = {
      task_id: 'step-1',
      task_kind: 'review' as const,
      action: 'discover.seed_search',
      task_intent: 'review.paper_set',
      description: 'Review the paper set.',
    };

    expect(deriveWorkflowTaskIntent(input)).toBe('review.paper_set');
  });

  it('keeps a generic fallback intent when neither task_intent nor action is present', () => {
    expect(deriveWorkflowTaskIntent({
      task_id: 'step-1',
      task_kind: 'literature',
      description: 'Fallback intent test.',
    })).toBe('workflow_step.step-1');
  });
});
