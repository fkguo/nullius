import { randomUUID } from 'node:crypto';

import { utcNowIso } from '../util.js';
import { ALLOWED_TASK_FOLLOWUPS, TASK_TRANSITIONS, interactiveResearchLoopPolicy } from './policy.js';
import type { ResearchCheckpoint } from './checkpoint-types.js';
import type { LoopIntervention, ResearchEvent } from './event-types.js';
import type { ResearchHandoff } from './handoff-types.js';
import type { ResearchTask, ResearchTaskInput, ResearchTaskStatus } from './task-types.js';
import type { ResearchWorkspace } from './workspace-types.js';

export type ResearchLoopMode = 'interactive' | 'autonomous';

export interface ResearchLoopPolicy {
  mode: ResearchLoopMode;
  /** Governs the initial status assigned to every newly registered task on this runtime. */
  auto_activate_injected_tasks: boolean;
}

export interface ResearchLoopRuntimeState {
  workspace: ResearchWorkspace;
  policy: ResearchLoopPolicy;
  tasks: ResearchTask[];
  events: ResearchEvent[];
  checkpoints: ResearchCheckpoint[];
  interventions: LoopIntervention[];
  handoffs: ResearchHandoff[];
  active_task_ids: string[];
}

export class ResearchLoopRuntime {
  private readonly state: ResearchLoopRuntimeState;

  constructor(options: { workspace: ResearchWorkspace; policy?: ResearchLoopPolicy }) {
    this.state = {
      workspace: options.workspace,
      policy: options.policy ?? interactiveResearchLoopPolicy(),
      tasks: [],
      events: [],
      checkpoints: [],
      interventions: [],
      handoffs: [],
      active_task_ids: [],
    };
  }

  getState(): Readonly<ResearchLoopRuntimeState> {
    return this.state;
  }

  createTask(input: ResearchTaskInput): ResearchTask {
    return this.registerTask(input, 'task_created', null);
  }

  injectTask(input: ResearchTaskInput): ResearchTask {
    return this.registerTask(input, 'task_injected', null);
  }

  appendDelegatedTask(input: { task: ResearchTaskInput; handoff?: ResearchHandoff }): ResearchTask {
    if (input.handoff) {
      this.state.handoffs.push(input.handoff);
      this.emit('handoff_registered', { source: input.handoff.source, actor_id: input.handoff.actor_id }, {
        handoff_id: input.handoff.handoff_id,
        handoff_kind: input.handoff.handoff_kind,
      });
    }
    return this.registerTask(input.task, 'task_injected', input.handoff?.handoff_id ?? null);
  }

  spawnFollowupTask(parentTaskId: string, input: ResearchTaskInput): ResearchTask {
    const parentTask = this.findTask(parentTaskId);
    if (!ALLOWED_TASK_FOLLOWUPS[parentTask.kind].includes(input.kind)) {
      throw new Error(`invalid follow-up from ${parentTask.kind} to ${input.kind}`);
    }
    return this.registerTask({ ...input }, 'task_followup_created', null, parentTaskId);
  }

  transitionTask(taskId: string, nextStatus: ResearchTaskStatus, meta: { source: ResearchTask['source']; actor_id?: string | null }): ResearchTask {
    const task = this.findTask(taskId);
    if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
      throw new Error(`invalid task transition: ${task.status} -> ${nextStatus}`);
    }
    const previousStatus = task.status;
    task.status = nextStatus;
    task.updated_at = utcNowIso();
    this.syncActiveTaskIds();
    this.emit('task_status_changed', meta, { from_status: previousStatus, to_status: nextStatus }, task.task_id);
    return task;
  }

  createCheckpoint(meta: { source: ResearchTask['source']; actor_id?: string | null; label?: string }): ResearchCheckpoint {
    const checkpoint: ResearchCheckpoint = {
      checkpoint_id: randomUUID(),
      created_at: utcNowIso(),
      label: meta.label ?? null,
      event_cursor: this.state.events.length,
      snapshot: {
        task_statuses: Object.fromEntries(this.state.tasks.map((task) => [task.task_id, task.status])),
        active_task_ids: [...this.state.active_task_ids],
      },
    };
    this.state.checkpoints.push(checkpoint);
    this.emit('checkpoint_created', meta, { label: checkpoint.label }, null, checkpoint.checkpoint_id);
    return checkpoint;
  }

  restoreCheckpoint(checkpointId: string, meta: { source: ResearchTask['source']; actor_id?: string | null }): ResearchCheckpoint {
    const checkpoint = this.state.checkpoints.find((item) => item.checkpoint_id === checkpointId);
    if (!checkpoint) {
      throw new Error(`unknown checkpoint: ${checkpointId}`);
    }
    for (const task of this.state.tasks) {
      const status = checkpoint.snapshot.task_statuses[task.task_id];
      if (status) {
        task.status = status;
        task.updated_at = utcNowIso();
      }
    }
    this.state.active_task_ids = [...checkpoint.snapshot.active_task_ids];
    this.emit('checkpoint_restored', meta, { restored_active_tasks: this.state.active_task_ids.length }, null, checkpoint.checkpoint_id);
    return checkpoint;
  }

  recordIntervention(input: {
    intervention_kind: LoopIntervention['intervention_kind'];
    source: ResearchTask['source'];
    actor_id?: string | null;
    payload?: Record<string, unknown>;
  }): LoopIntervention {
    const intervention: LoopIntervention = {
      intervention_id: randomUUID(),
      intervention_kind: input.intervention_kind,
      created_at: utcNowIso(),
      source: input.source,
      actor_id: input.actor_id ?? null,
      payload: input.payload ?? {},
    };
    this.state.interventions.push(intervention);
    this.emit('intervention_recorded', { source: input.source, actor_id: input.actor_id ?? null }, {
      intervention_kind: input.intervention_kind,
      ...intervention.payload,
    });
    return intervention;
  }

  private registerTask(input: ResearchTaskInput, eventType: ResearchEvent['event_type'], handoffId: string | null, parentTaskId: string | null = null): ResearchTask {
    this.ensureWorkspaceNode(input.target_node_id);
    const timestamp = utcNowIso();
    const task: ResearchTask = {
      task_id: randomUUID(),
      kind: input.kind,
      title: input.title,
      target_node_id: input.target_node_id,
      source: input.source,
      actor_id: input.actor_id ?? null,
      metadata: input.metadata,
      status: this.state.policy.auto_activate_injected_tasks ? 'active' : 'pending',
      parent_task_id: parentTaskId,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.state.tasks.push(task);
    this.syncActiveTaskIds();
    this.emit(eventType, { source: input.source, actor_id: input.actor_id ?? null }, { kind: input.kind, parent_task_id: parentTaskId }, task.task_id, null, handoffId);
    return task;
  }

  private emit(
    eventType: ResearchEvent['event_type'],
    meta: { source: ResearchTask['source']; actor_id?: string | null },
    payload: Record<string, unknown>,
    taskId: string | null = null,
    checkpointId: string | null = null,
    handoffId: string | null = null,
  ): void {
    this.state.events.push({
      event_id: randomUUID(),
      event_type: eventType,
      created_at: utcNowIso(),
      source: meta.source,
      actor_id: meta.actor_id ?? null,
      task_id: taskId,
      checkpoint_id: checkpointId,
      handoff_id: handoffId,
      payload,
    });
  }

  private ensureWorkspaceNode(nodeId: string): void {
    if (!this.state.workspace.nodes.some((node) => node.node_id === nodeId)) {
      throw new Error(`unknown workspace node: ${nodeId}`);
    }
  }

  private findTask(taskId: string): ResearchTask {
    const task = this.state.tasks.find((candidate) => candidate.task_id === taskId);
    if (!task) {
      throw new Error(`unknown task: ${taskId}`);
    }
    return task;
  }

  private syncActiveTaskIds(): void {
    this.state.active_task_ids = this.state.tasks
      .filter((task) => task.status === 'active')
      .map((task) => task.task_id);
  }
}
