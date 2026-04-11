import { describe, expect, it } from 'vitest';
import {
  WorkflowTaskKindSchema,
  WorkflowStepTaskProjectionSchema,
} from '../types/task-projection.js';

describe('WorkflowTaskKindSchema', () => {
  it('accepts supported provider-neutral task kinds', () => {
    expect(WorkflowTaskKindSchema.parse('literature')).toBe('literature');
    expect(WorkflowTaskKindSchema.parse('review')).toBe('review');
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
      preconditions: ['topic is defined'],
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
