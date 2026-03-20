import {
  HEP_PROJECT_PLAYBACK_EVIDENCE,
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_RENDER_LATEX,
  HEP_RUN_BUILD_WRITING_EVIDENCE,
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_STAGE_CONTENT,
} from '../tool-names.js';
import { zodToMcpInputSchema } from './mcpSchema.js';
import {
  HepProjectPlaybackEvidenceToolSchema,
  HepProjectQueryEvidenceToolSchema,
  HepRenderLatexToolSchema,
  HepRunBuildWritingEvidenceToolSchema,
  HepRunReadArtifactChunkToolSchema,
  HepRunStageContentToolSchema,
} from './registry/projectSchemas.js';

export const DEFAULT_DELEGATE_MODEL = 'claude-opus-4-6';

const FOLLOWUP_TOOL_SPECS = [
  {
    name: HEP_RUN_READ_ARTIFACT_CHUNK,
    description: 'Read a small byte-range chunk from a HEP run artifact.',
    schema: HepRunReadArtifactChunkToolSchema,
  },
  {
    name: HEP_RUN_STAGE_CONTENT,
    description: 'Stage large client content into a run artifact.',
    schema: HepRunStageContentToolSchema,
  },
  {
    name: HEP_PROJECT_QUERY_EVIDENCE,
    description: 'Query a project evidence catalog.',
    schema: HepProjectQueryEvidenceToolSchema,
  },
  {
    name: HEP_PROJECT_PLAYBACK_EVIDENCE,
    description: 'Playback an evidence locator.',
    schema: HepProjectPlaybackEvidenceToolSchema,
  },
  {
    name: HEP_RUN_BUILD_WRITING_EVIDENCE,
    description: 'Build writing evidence artifacts for a run.',
    schema: HepRunBuildWritingEvidenceToolSchema,
  },
  {
    name: HEP_RENDER_LATEX,
    description: 'Render a structured draft into LaTeX artifacts.',
    schema: HepRenderLatexToolSchema,
  },
] as const;

export const FOLLOWUP_RUNTIME_TOOLS = FOLLOWUP_TOOL_SPECS.map(spec => ({
  name: spec.name,
  description: spec.description,
  input_schema: zodToMcpInputSchema(spec.schema),
}));

export function buildFollowupPrompt(params: {
  bridgeUri: string | null;
  computationResultUri: string;
  projectId: string;
  runId: string;
  taskId: string;
  taskKind: string;
  taskTitle: string;
  handoffId: string;
  handoffKind: string;
}): string {
  const lines = [
    'Continue exactly one computation-generated delegated follow-up.',
    `project_id: ${params.projectId}`,
    `run_id: ${params.runId}`,
    `task_id: ${params.taskId}`,
    `task_kind: ${params.taskKind}`,
    `task_title: ${params.taskTitle}`,
    `computation_result_uri: ${params.computationResultUri}`,
    `handoff_id: ${params.handoffId}`,
    `handoff_kind: ${params.handoffKind}`,
  ];
  if (params.bridgeUri) lines.push(`bridge_uri: ${params.bridgeUri}`);
  lines.push('Use the existing ResearchWorkspace, tasks, handoffs, and bridge artifacts as the sole source of truth.');
  lines.push('Stay within this single supervised_delegate assignment. Do not launch other runtimes, schedulers, or parallel assignments.');
  return lines.join('\n');
}
