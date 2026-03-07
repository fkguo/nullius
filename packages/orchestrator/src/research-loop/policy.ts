import type { ResearchTaskKind, ResearchTaskStatus } from './task-types.js';
import type { ResearchLoopPolicy } from './runtime.js';

export const TASK_TRANSITIONS: Record<ResearchTaskStatus, ResearchTaskStatus[]> = {
  pending: ['active', 'cancelled'],
  active: ['completed', 'blocked', 'cancelled'],
  blocked: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const ALLOWED_TASK_FOLLOWUPS: Record<ResearchTaskKind, ResearchTaskKind[]> = {
  literature: ['idea'],
  idea: ['compute', 'literature'],
  compute: ['literature', 'idea', 'finding'],
  evidence_search: ['draft_update', 'idea'],
  finding: ['draft_update'],
  draft_update: ['review'],
  review: ['evidence_search'],
};

export function interactiveResearchLoopPolicy(): ResearchLoopPolicy {
  return { mode: 'interactive', auto_activate_injected_tasks: false };
}

export function autonomousResearchLoopPolicy(): ResearchLoopPolicy {
  return { mode: 'autonomous', auto_activate_injected_tasks: true };
}
