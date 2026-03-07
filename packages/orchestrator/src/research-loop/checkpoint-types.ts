import type { ResearchTaskStatus } from './task-types.js';

export interface ResearchCheckpoint {
  checkpoint_id: string;
  created_at: string;
  label: string | null;
  event_cursor: number;
  snapshot: {
    task_statuses: Record<string, ResearchTaskStatus>;
    active_task_ids: string[];
  };
}
