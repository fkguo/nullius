import type { ResearchLoopPacketV1 } from '@autoresearch/shared';
import { ALLOWED_TASK_FOLLOWUPS } from './policy.js';
import type { ResearchWorkspace } from './workspace-types.js';

export type ResearchLoopPacket = ResearchLoopPacketV1;

type SurfaceRef = ResearchLoopPacket['mutable_surfaces'][number];
type StopCondition = ResearchLoopPacket['stop_conditions'][number];
type Transition = ResearchLoopPacket['advancement']['allowed_followups'][number];
type TaskKind = Transition['from_task_kind'];

export interface CreateResearchLoopPacketOptions {
  workspace: ResearchWorkspace;
  objective?: string;
  packet_id?: string;
  mutable_surfaces?: ResearchLoopPacket['mutable_surfaces'];
  immutable_authority_refs?: ResearchLoopPacket['immutable_authority_refs'];
  gate_conditions?: ResearchLoopPacket['gate_conditions'];
  advancement?: ResearchLoopPacket['advancement'];
  rollback?: ResearchLoopPacket['rollback'];
  stop_conditions?: ResearchLoopPacket['stop_conditions'];
}

const DEFAULT_HANDOFF_KINDS = ['compute', 'feedback', 'writing', 'review'] as const;
const DEFAULT_ROLLBACK_TRANSITIONS: Transition[] = [
  { from_task_kind: 'compute', to_task_kind: 'literature' },
  { from_task_kind: 'compute', to_task_kind: 'idea' },
  { from_task_kind: 'review', to_task_kind: 'evidence_search' },
];

function toNonEmptyArray<T>(values: T[], label: string): [T, ...T[]] {
  const [first, ...rest] = values;
  if (!first) {
    throw new Error(`research_loop_packet_v1 ${label} must not be empty`);
  }
  return [first, ...rest];
}

function transitionKey(transition: Transition): string {
  return `${transition.from_task_kind}->${transition.to_task_kind}`;
}

function defaultObjective(workspace: ResearchWorkspace): string {
  return workspace.nodes.find((node) => node.node_id === workspace.primary_question_id)?.title
    ?? `Research loop for ${workspace.workspace_id}`;
}

function defaultMutableSurfaces(workspace: ResearchWorkspace): ResearchLoopPacket['mutable_surfaces'] {
  const nodeRefs: SurfaceRef[] = workspace.nodes
    .filter((node) => node.node_id !== workspace.primary_question_id && node.kind !== 'decision')
    .map((node) => ({ ref_kind: 'workspace_node', node_id: node.node_id }));
  const edgeRefs: SurfaceRef[] = workspace.edges.map((edge) => ({ ref_kind: 'workspace_edge', edge_id: edge.edge_id }));
  const taskRefs: SurfaceRef[] = (Object.keys(ALLOWED_TASK_FOLLOWUPS) as TaskKind[]).map((task_kind) => ({ ref_kind: 'task', task_kind }));
  const handoffRefs: SurfaceRef[] = DEFAULT_HANDOFF_KINDS.map((handoff_kind) => ({ ref_kind: 'handoff', handoff_kind }));
  return toNonEmptyArray([...nodeRefs, ...edgeRefs, ...taskRefs, ...handoffRefs], 'mutable_surfaces');
}

function defaultImmutableAuthorityRefs(workspace: ResearchWorkspace): ResearchLoopPacket['immutable_authority_refs'] {
  const refs: SurfaceRef[] = [{ ref_kind: 'workspace_node', node_id: workspace.primary_question_id }];
  for (const node of workspace.nodes) {
    if (node.kind === 'decision') {
      refs.push({ ref_kind: 'workspace_node', node_id: node.node_id });
    }
  }
  return toNonEmptyArray(refs, 'immutable_authority_refs');
}

function defaultGateConditions(workspace: ResearchWorkspace): ResearchLoopPacket['gate_conditions'] {
  const reviewNode = workspace.nodes.find((node) => node.kind === 'review_issue');
  return toNonEmptyArray([
    { condition_kind: 'task_status', task_kind: 'compute', allowed_statuses: ['completed', 'blocked'] },
    { condition_kind: 'task_status', task_kind: 'review', allowed_statuses: ['completed'], ...(reviewNode ? { target_node_id: reviewNode.node_id } : {}) },
    { condition_kind: 'handoff_registered', handoff_kind: 'compute' },
    { condition_kind: 'handoff_registered', handoff_kind: 'feedback' },
    { condition_kind: 'handoff_registered', handoff_kind: 'writing' },
    { condition_kind: 'handoff_registered', handoff_kind: 'review' },
  ], 'gate_conditions');
}

function defaultAdvancement(): ResearchLoopPacket['advancement'] {
  const allowed_followups: Transition[] = [];
  for (const [from_task_kind, nextTaskKinds] of Object.entries(ALLOWED_TASK_FOLLOWUPS)) {
    for (const to_task_kind of nextTaskKinds) {
      allowed_followups.push({ from_task_kind: from_task_kind as TaskKind, to_task_kind });
    }
  }
  return { allowed_followups: toNonEmptyArray(allowed_followups, 'advancement.allowed_followups') };
}

function defaultRollback(workspace: ResearchWorkspace): ResearchLoopPacket['rollback'] {
  const nodeIds = new Set(workspace.nodes.map((node) => node.node_id));
  return {
    allowed_backtracks: toNonEmptyArray(DEFAULT_ROLLBACK_TRANSITIONS.filter((transition) => {
      if (transition.to_task_kind === 'evidence_search') {
        return workspace.nodes.some((node) => node.kind === 'review_issue');
      }
      if (transition.to_task_kind === 'literature') {
        return workspace.nodes.some((node) => node.kind === 'evidence_set');
      }
      if (transition.to_task_kind === 'idea') {
        return [...nodeIds].some((nodeId) => nodeId === workspace.primary_question_id || workspace.nodes.some((node) => node.node_id === nodeId && node.kind === 'idea'));
      }
      return false;
    }), 'rollback.allowed_backtracks'),
  };
}

function defaultStopConditions(workspace: ResearchWorkspace): ResearchLoopPacket['stop_conditions'] {
  const stopConditions: StopCondition[] = [
    { condition_kind: 'no_active_tasks' },
    { condition_kind: 'task_terminal', task_kind: 'review', terminal_statuses: ['completed', 'cancelled'] },
    { condition_kind: 'intervention', intervention_kind: 'pause' },
    { condition_kind: 'intervention', intervention_kind: 'cancel' },
    { condition_kind: 'intervention', intervention_kind: 'cascade_stop' },
  ];
  for (const node of workspace.nodes) {
    if (node.kind === 'decision') {
      stopConditions.push({ condition_kind: 'decision_node', node_id: node.node_id });
    }
  }
  return toNonEmptyArray(stopConditions, 'stop_conditions');
}

function assertSurfaceRefWithinWorkspace(ref: SurfaceRef, workspace: ResearchWorkspace): void {
  const nodeIds = new Set(workspace.nodes.map((node) => node.node_id));
  const edgeIds = new Set(workspace.edges.map((edge) => edge.edge_id));
  if (ref.ref_kind === 'workspace_node' && !nodeIds.has(ref.node_id)) {
    throw new Error(`research_loop_packet_v1 references unknown workspace node: ${ref.node_id}`);
  }
  if (ref.ref_kind === 'workspace_edge' && !edgeIds.has(ref.edge_id)) {
    throw new Error(`research_loop_packet_v1 references unknown workspace edge: ${ref.edge_id}`);
  }
  if ((ref.ref_kind === 'task' || ref.ref_kind === 'handoff') && ref.target_node_id && !nodeIds.has(ref.target_node_id)) {
    throw new Error(`research_loop_packet_v1 references unknown target node: ${ref.target_node_id}`);
  }
}

function assertTransitionsAllowed(transitions: Transition[], allowed: ReadonlySet<string>, label: string): void {
  for (const transition of transitions) {
    if (!allowed.has(transitionKey(transition))) {
      throw new Error(`research_loop_packet_v1 ${label} transition is outside the single-project loop surface: ${transitionKey(transition)}`);
    }
  }
}

export function assertResearchLoopPacket(packet: ResearchLoopPacket, workspace: ResearchWorkspace): void {
  if (packet.scope !== 'single_project') {
    throw new Error(`research_loop_packet_v1 must remain single_project scoped, received: ${packet.scope}`);
  }
  if (packet.workspace_id !== workspace.workspace_id) {
    throw new Error(`research_loop_packet_v1 workspace_id mismatch: ${packet.workspace_id} !== ${workspace.workspace_id}`);
  }
  if (!packet.immutable_authority_refs.some((ref) => ref.ref_kind === 'workspace_node' && ref.node_id === workspace.primary_question_id)) {
    throw new Error('research_loop_packet_v1 immutable_authority_refs must include the primary question node');
  }
  for (const ref of [...packet.mutable_surfaces, ...packet.immutable_authority_refs]) {
    assertSurfaceRefWithinWorkspace(ref, workspace);
  }
  for (const condition of packet.gate_conditions) {
    if ((condition.condition_kind === 'task_status' || condition.condition_kind === 'handoff_registered') && condition.target_node_id) {
      assertSurfaceRefWithinWorkspace({ ref_kind: 'workspace_node', node_id: condition.target_node_id }, workspace);
    }
  }
  for (const condition of packet.stop_conditions) {
    if (condition.condition_kind === 'decision_node') {
      assertSurfaceRefWithinWorkspace({ ref_kind: 'workspace_node', node_id: condition.node_id }, workspace);
    }
  }
  const allowedFollowups = new Set(
    Object.entries(ALLOWED_TASK_FOLLOWUPS)
      .flatMap(([from_task_kind, nextTaskKinds]) => nextTaskKinds.map((to_task_kind) => `${from_task_kind}->${to_task_kind}`)),
  );
  assertTransitionsAllowed(packet.advancement.allowed_followups, allowedFollowups, 'advancement');
  // V1 keeps rollback fail-closed to the substrate's existing legal backtracks.
  assertTransitionsAllowed(packet.rollback.allowed_backtracks, new Set(DEFAULT_ROLLBACK_TRANSITIONS.map(transitionKey)), 'rollback');
}

export function createResearchLoopPacket(options: CreateResearchLoopPacketOptions): ResearchLoopPacket {
  const packet: ResearchLoopPacket = {
    schema_version: 1,
    scope: 'single_project',
    packet_id: options.packet_id ?? `packet:${options.workspace.workspace_id}`,
    workspace_id: options.workspace.workspace_id,
    objective: options.objective ?? defaultObjective(options.workspace),
    mutable_surfaces: options.mutable_surfaces ?? defaultMutableSurfaces(options.workspace),
    immutable_authority_refs: options.immutable_authority_refs ?? defaultImmutableAuthorityRefs(options.workspace),
    gate_conditions: options.gate_conditions ?? defaultGateConditions(options.workspace),
    advancement: options.advancement ?? defaultAdvancement(),
    rollback: options.rollback ?? defaultRollback(options.workspace),
    stop_conditions: options.stop_conditions ?? defaultStopConditions(options.workspace),
  };
  assertResearchLoopPacket(packet, options.workspace);
  return packet;
}
