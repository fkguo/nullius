import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ApprovalPacketV1,
  ArtifactRefV1,
  ComputationResultV1,
  FinalConclusionsV1,
  VerificationCoverageV1,
  VerificationSubjectV1,
  VerificationSubjectVerdictV1,
} from '@autoresearch/shared';
import {
  createArtifactRefV1,
  evaluateVerificationKernelGateV1,
  invalidParams,
  makeScopedArtifactUri,
  notFound,
} from '@autoresearch/shared';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';
import { createRunArtifactRef } from '../computation/artifact-refs.js';
import { assertComputationResultValid } from '../computation/result-schema.js';
import artifactRefSchema from '../../../../meta/schemas/artifact_ref_v1.schema.json' with { type: 'json' };
import finalConclusionsSchema from '../../../../meta/schemas/final_conclusions_v1.schema.json' with { type: 'json' };
import { sha256Text, writeJsonAtomic, writeTextAtomic } from '../computation/io.js';
import {
  attachFinalConclusionsApprovalToWorkspaceFeedback,
  attachFinalConclusionsRequestToWorkspaceFeedback,
} from '../computation/workspace-feedback-boundaries.js';
import { recordFinalConclusionsToMemoryGraph } from '../computation/memory-graph-hookup.js';
import { createStateManager, requireState } from './common.js';
import { OrchRunRequestFinalConclusionsSchema } from './schemas.js';
import type { RunState } from '../types.js';

type GateOutcome = ReturnType<typeof evaluateVerificationKernelGateV1>;

type AjvConstructor = new (options: Record<string, unknown>) => {
  addSchema?: (schema: Record<string, unknown>, key?: string) => void;
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

const ajv = new (Ajv2020 as unknown as AjvConstructor)({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

ajv.addSchema?.(
  artifactRefSchema as Record<string, unknown>,
  'https://autoresearch.dev/schemas/artifact_ref_v1.schema.json',
);

const finalConclusionsValidator = ajv.compile(finalConclusionsSchema as Record<string, unknown>);

function runDirFromProjectRoot(projectRoot: string, runId: string): string {
  return path.join(projectRoot, runId);
}

function approvalArtifacts(projectRoot: string, runId: string, approvalId: string) {
  const approvalDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals', approvalId);
  return {
    approvalDir,
    packetShortPath: path.join(approvalDir, 'packet_short.md'),
    packetFullPath: path.join(approvalDir, 'packet.md'),
    packetJsonPath: path.join(approvalDir, 'approval_packet_v1.json'),
  };
}

function finalConclusionsArtifactPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, 'artifacts', 'runs', runId, 'final_conclusions_v1.json');
}

function readJsonFile<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) {
    throw notFound(`${label} not found at ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function runArtifactPathFromUri(runDir: string, uri: string): string {
  const prefix = 'rep://runs/';
  if (!uri.startsWith(prefix)) {
    throw invalidParams(`final-conclusions gate only supports rep://runs artifact refs, got: ${uri}`);
  }
  const artifactMarker = '/artifact/';
  const artifactIndex = uri.indexOf(artifactMarker);
  if (artifactIndex < 0) {
    throw invalidParams(`final-conclusions gate requires artifact refs, got: ${uri}`);
  }
  const relativePath = decodeURIComponent(uri.slice(artifactIndex + artifactMarker.length));
  const filePath = path.resolve(runDir, relativePath);
  if (filePath !== runDir && !filePath.startsWith(`${runDir}${path.sep}`)) {
    throw invalidParams(`final-conclusions gate artifact ref escapes run dir: ${uri}`);
  }
  if (!fs.existsSync(filePath)) {
    throw notFound(`final-conclusions gate artifact ref not found: ${uri}`);
  }
  return filePath;
}

function loadJsonArtifact<T>(runDir: string, ref: ArtifactRefV1): T {
  return JSON.parse(fs.readFileSync(runArtifactPathFromUri(runDir, ref.uri), 'utf-8')) as T;
}

function assertFinalConclusionsValid(raw: unknown): FinalConclusionsV1 {
  if (!finalConclusionsValidator(raw)) {
    throw invalidParams('final_conclusions_v1 validation failed', {
      validation_layer: 'final_conclusions',
      issues: finalConclusionsValidator.errors ?? [],
    });
  }
  return raw as FinalConclusionsV1;
}

function loadComputationResult(projectRoot: string, runId: string): {
  computationResult: ComputationResultV1;
  computationResultPath: string;
  runDir: string;
} {
  const runDir = runDirFromProjectRoot(projectRoot, runId);
  const computationResultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  const parsed = readJsonFile<unknown>(computationResultPath, 'computation_result_v1.json');
  const computationResult = assertComputationResultValid(parsed);
  if (computationResult.run_id !== runId) {
    throw invalidParams('computation_result_v1 run_id does not match requested run_id', {
      run_id: runId,
      computation_result_run_id: computationResult.run_id,
    });
  }
  return { computationResult, computationResultPath, runDir };
}

function evaluateFinalConclusionsGate(projectRoot: string, runId: string): {
  gate: GateOutcome;
  computationResult: ComputationResultV1;
  computationResultPath: string;
  runDir: string;
} {
  const { computationResult, computationResultPath, runDir } = loadComputationResult(projectRoot, runId);
  const refs = computationResult.verification_refs;
  if (!refs?.subject_refs?.length || !refs.subject_verdict_refs?.length || !refs.coverage_refs?.length) {
    return {
      gate: {
        decision: 'unavailable',
        summary: 'Canonical computation_result_v1 is missing typed verification refs required for final conclusions.',
      },
      computationResult,
      computationResultPath,
      runDir,
    };
  }
  const subject = loadJsonArtifact<VerificationSubjectV1>(runDir, refs.subject_refs[0]!);
  const verdict = loadJsonArtifact<VerificationSubjectVerdictV1>(runDir, refs.subject_verdict_refs[0]!);
  const coverage = loadJsonArtifact<VerificationCoverageV1>(runDir, refs.coverage_refs[0]!);
  return {
    gate: evaluateVerificationKernelGateV1({
      expected_run_id: runId,
      subject,
      verdict,
      coverage,
    }),
    computationResult,
    computationResultPath,
    runDir,
  };
}

function pendingPacketJsonPath(projectRoot: string, packetPathRel: string): string {
  return path.join(projectRoot, path.dirname(packetPathRel), 'approval_packet_v1.json');
}

function createControlPlaneArtifactRef(params: {
  artifactName: string;
  filePath: string;
  kind: string;
  runId: string;
}): ArtifactRefV1 {
  const stat = fs.statSync(params.filePath);
  return createArtifactRefV1({
    uri: makeScopedArtifactUri({
      scheme: 'orch',
      scope: 'runs',
      scopeId: params.runId,
      artifactName: params.artifactName,
    }),
    sha256: createHash('sha256').update(fs.readFileSync(params.filePath)).digest('hex'),
    kind: params.kind,
    size_bytes: stat.size,
    produced_by: '@autoresearch/orchestrator',
  });
}

function artifactRelativePathFromUri(uri: string): string | null {
  const marker = '/artifact/';
  const index = uri.indexOf(marker);
  if (index < 0) return null;
  return decodeURIComponent(uri.slice(index + marker.length));
}

function formatOutputs(computationResult: ComputationResultV1): string[] {
  return [
    'artifacts/computation_result_v1.json',
    ...(computationResult.verification_refs?.subject_refs ?? []).map(ref => artifactRelativePathFromUri(ref.uri) ?? ''),
    ...(computationResult.verification_refs?.subject_verdict_refs ?? []).map(ref => artifactRelativePathFromUri(ref.uri) ?? ''),
    ...(computationResult.verification_refs?.coverage_refs ?? []).map(ref => artifactRelativePathFromUri(ref.uri) ?? ''),
  ].filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

function buildApprovalPacket(params: {
  state: RunState;
  runId: string;
  computationResult: ComputationResultV1;
  gate: GateOutcome;
  approvalId: string;
}): ApprovalPacketV1 {
  const requestedAt = new Date().toISOString();
  const verificationRefs = params.computationResult.verification_refs;
  const verificationRefLines = [
    ...(verificationRefs?.subject_refs ?? []).map(ref => `- subject: ${ref.uri}`),
    ...(verificationRefs?.subject_verdict_refs ?? []).map(ref => `- verdict: ${ref.uri}`),
    ...(verificationRefs?.coverage_refs ?? []).map(ref => `- coverage: ${ref.uri}`),
  ];
  return {
    schema_version: 1,
    approval_id: params.approvalId,
    gate_id: 'A5',
    run_id: params.runId,
    ...(params.state.workflow_id ? { workflow_id: params.state.workflow_id } : {}),
    purpose: `Authorize the first final-conclusions (A5) boundary request for run ${params.runId} after decisive verification passed.`,
    plan: [
      `Verify canonical computation_result_v1 readiness for ${params.runId}`,
      'Create an A5 pending approval on the existing generic approval substrate',
    ],
    risks: [
      'Final conclusions must not advance on hold, block, or unavailable verification truth.',
      'This request is grounded only in canonical computation_result_v1 verification refs, not provider-local inferred publication state.',
      'Approval only authorizes higher-conclusion progression; it does not create a separate publication runtime.',
    ],
    budgets: {},
    outputs: formatOutputs(params.computationResult),
    rollback: `Reject ${params.approvalId} or refresh verification truth before requesting final conclusions again.`,
    commands: [],
    checklist: [
      'Confirm decisive verification truth is an explicit pass.',
      'Confirm the request is grounded in canonical computation_result_v1 refs rather than provider-local inferred state.',
      'Confirm the run summary is ready to cross the A5 final-conclusions boundary.',
    ],
    requested_at: requestedAt,
    plan_step_ids: [],
    gate_resolution_trace: [{
      gate_id: 'A5',
      triggered_by: 'orch_run_request_final_conclusions',
      reason: params.gate.summary,
      timestamp_utc: requestedAt,
    }],
    details_md: [
      `# A5 final-conclusions request for ${params.runId}`,
      '',
      `Objective: ${params.computationResult.objective_title}`,
      `Execution status: ${params.computationResult.execution_status}`,
      `Gate decision: ${params.gate.decision}`,
      `Gate summary: ${params.gate.summary}`,
      '',
      'Verification refs:',
      ...(verificationRefLines.length > 0 ? verificationRefLines : ['- none']),
      '',
      'Summary:',
      params.computationResult.summary,
    ].join('\n'),
  };
}

function writeApprovalPacketArtifacts(params: {
  projectRoot: string;
  state: RunState;
  runId: string;
  computationResult: ComputationResultV1;
  gate: GateOutcome;
  approvalId: string;
}): {
  packetPath: string;
  packetJsonPath: string;
  packetSha256: string;
} {
  const packet = buildApprovalPacket(params);
  const artifacts = approvalArtifacts(params.projectRoot, params.runId, params.approvalId);
  const packetJsonText = JSON.stringify(packet, null, 2) + '\n';
  writeTextAtomic(
    artifacts.packetShortPath,
    `# Approval: ${params.approvalId} (A5)\n\nRun: ${params.runId}\nGate summary: ${params.gate.summary}\n`,
  );
  writeTextAtomic(
    artifacts.packetFullPath,
    `# Approval packet — ${params.approvalId} (A5)\n\n${packet.purpose}\n\n## Gate summary\n${params.gate.summary}\n`,
  );
  writeJsonAtomic(artifacts.packetJsonPath, packet);
  return {
    packetPath: path.relative(params.projectRoot, artifacts.packetShortPath).split(path.sep).join('/'),
    packetJsonPath: path.relative(params.projectRoot, artifacts.packetJsonPath).split(path.sep).join('/'),
    packetSha256: sha256Text(packetJsonText),
  };
}

function existingPendingA5(projectRoot: string, state: RunState, runId: string) {
  const pending = state.pending_approval;
  if (!pending || pending.category !== 'A5') {
    return null;
  }
  const packetPathRel = typeof pending.packet_path === 'string' ? pending.packet_path : null;
  if (!packetPathRel) {
    throw invalidParams('Pending A5 approval has no packet_path.', { run_id: runId });
  }
  const packetJsonPath = pendingPacketJsonPath(projectRoot, packetPathRel);
  if (!fs.existsSync(packetJsonPath)) {
    throw notFound(`approval_packet_v1.json not found at ${packetJsonPath}`);
  }
  return {
    status: 'requires_approval' as const,
    requires_approval: true,
    gate_id: 'A5' as const,
    gate_decision: 'pass' as const,
    gate_summary: 'A5 approval request already exists for this run.',
    run_id: runId,
    approval_id: pending.approval_id,
    approval_packet_sha256: createHash('sha256').update(fs.readFileSync(packetJsonPath)).digest('hex'),
    packet_path: packetPathRel,
    packet_json_path: path.relative(projectRoot, packetJsonPath).split(path.sep).join('/'),
    uri: `orch://runs/${runId}`,
    message: `Approval required: ${pending.approval_id}`,
  };
}

export async function consumeApprovedFinalConclusions(params: {
  approvalId: string;
  note?: string;
  packetJsonPath: string;
  packetPathRel: string;
  packetSha256: string;
  projectRoot: string;
  state: RunState;
}): Promise<{
  final_conclusions_path: string;
  final_conclusions_uri: string;
  cleanup: () => void;
}> {
  const pending = params.state.pending_approval;
  if (!pending || pending.category !== 'A5' || pending.approval_id !== params.approvalId) {
    throw invalidParams('final conclusions consumer requires a matching pending A5 approval.', {
      approval_id: params.approvalId,
      pending_approval_id: pending?.approval_id ?? null,
      pending_category: pending?.category ?? null,
    });
  }
  const runId = params.state.run_id;
  if (!runId) {
    throw invalidParams('final conclusions consumer requires an active run_id in state.', {});
  }

  const packet = readJsonFile<ApprovalPacketV1>(params.packetJsonPath, 'approval_packet_v1.json');
  if (packet.gate_id !== 'A5') {
    throw invalidParams('final conclusions consumer requires an A5 approval packet.', {
      gate_id: packet.gate_id,
    });
  }

  const { gate, computationResult, computationResultPath, runDir } = evaluateFinalConclusionsGate(params.projectRoot, runId);
  if (gate.decision !== 'pass') {
    throw invalidParams('A5 approval cannot complete because higher-conclusion readiness is no longer a decisive pass.', {
      gate_decision: gate.decision,
      gate_summary: gate.summary,
      run_id: runId,
    });
  }

  const finalConclusionsPath = finalConclusionsArtifactPath(params.projectRoot, runId);
  const finalConclusionsUri = makeScopedArtifactUri({
    scheme: 'orch',
    scope: 'runs',
    scopeId: runId,
    artifactName: 'final_conclusions_v1.json',
  });
  const originalComputationResultText = fs.readFileSync(computationResultPath, 'utf-8');
  const sourceResultRef = createRunArtifactRef(runId, runDir, computationResultPath, 'computation_result');
  const approvalPacketRef = createControlPlaneArtifactRef({
    artifactName: `approvals/${params.approvalId}/approval_packet_v1.json`,
    filePath: params.packetJsonPath,
    kind: 'approval_packet',
    runId,
  });
  const createdAt = new Date().toISOString();
  const payload = assertFinalConclusionsValid({
    schema_version: 1,
    run_id: runId,
    approval_id: params.approvalId,
    gate_id: 'A5',
    source_result_ref: sourceResultRef,
    objective_title: computationResult.objective_title,
    source_result_summary: computationResult.summary,
    produced_artifact_refs: computationResult.produced_artifact_refs,
    verification_check_run_refs: computationResult.verification_refs?.check_run_refs ?? [],
    approval_packet_ref: approvalPacketRef,
    verification_summary: {
      decision: 'pass',
      summary: gate.summary,
    },
    summary: `A5 final conclusions were approved for ${runId}: ${computationResult.summary}`,
    created_at: createdAt,
    provenance: {
      orchestrator_component: '@autoresearch/orchestrator',
      trigger_surface: 'post_a5_approval_consumer',
      approved_via: 'orch_run_approve',
      ...(params.note ? { note: params.note } : {}),
    },
  });

  writeJsonAtomic(finalConclusionsPath, payload);
  try {
    const nextComputationResult = attachFinalConclusionsApprovalToWorkspaceFeedback(computationResult, {
      approval_id: params.approvalId,
      final_conclusions_path: path.relative(params.projectRoot, finalConclusionsPath).split(path.sep).join('/'),
      final_conclusions_uri: finalConclusionsUri,
    });
    writeJsonAtomic(computationResultPath, assertComputationResultValid(nextComputationResult));
    await recordFinalConclusionsToMemoryGraph({
      projectRoot: params.projectRoot,
      runId,
      approvalId: params.approvalId,
      finalConclusionsUri,
      summary: payload.summary,
    });
  } catch (error) {
    try {
      if (fs.existsSync(finalConclusionsPath)) {
        fs.unlinkSync(finalConclusionsPath);
      }
      fs.writeFileSync(computationResultPath, originalComputationResultText, 'utf-8');
    } catch {
      // best-effort rollback only; preserve original error below
    }
    throw error;
  }
  return {
    final_conclusions_path: path.relative(params.projectRoot, finalConclusionsPath).split(path.sep).join('/'),
    final_conclusions_uri: finalConclusionsUri,
    cleanup: () => {
      try {
        if (fs.existsSync(finalConclusionsPath)) {
          fs.unlinkSync(finalConclusionsPath);
        }
        fs.writeFileSync(computationResultPath, originalComputationResultText, 'utf-8');
      } catch {
        // best-effort cleanup only; fail-closed state preservation matters more than cleanup reporting
      }
    },
  };
}

function readFinalConclusionsPointer(state: RunState): string | null {
  const pointer = state.artifacts?.final_conclusions_v1;
  return typeof pointer === 'string' && pointer.length > 0 ? pointer : null;
}

function resolveFinalConclusionsPath(projectRoot: string, pointer: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, pointer);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidParams('final_conclusions_v1 pointer escapes project root.', {
      project_root: projectRoot,
      pointer,
    });
  }
  return resolved;
}

export function readFinalConclusionsView(projectRoot: string, state: RunState): {
  final_conclusions: Record<string, unknown> | null;
  final_conclusions_error: Record<string, unknown> | null;
} {
  const pointer = readFinalConclusionsPointer(state);
  if (!pointer || !state.run_id) {
    return { final_conclusions: null, final_conclusions_error: null };
  }
  try {
    const filePath = resolveFinalConclusionsPath(projectRoot, pointer);
    if (!fs.existsSync(filePath)) {
      return {
        final_conclusions: null,
        final_conclusions_error: {
          code: 'FINAL_CONCLUSIONS_MISSING',
          message: `final_conclusions_v1 pointer exists but file is missing at ${pointer}.`,
        },
      };
    }
    const parsed = readJsonFile<unknown>(filePath, 'final_conclusions_v1.json');
    const artifact = assertFinalConclusionsValid(parsed) as FinalConclusionsV1 & {
      objective_title?: string;
      source_result_summary?: string;
      produced_artifact_refs?: ArtifactRefV1[];
      verification_check_run_refs?: ArtifactRefV1[];
    };
    return {
      final_conclusions: {
        artifact_path: pointer,
        artifact_uri: makeScopedArtifactUri({
          scheme: 'orch',
          scope: 'runs',
          scopeId: state.run_id,
          artifactName: 'final_conclusions_v1.json',
        }),
        approval_id: artifact.approval_id,
        objective_title: artifact.objective_title,
        summary: artifact.summary,
        created_at: artifact.created_at,
        verification_summary: artifact.verification_summary,
      },
      final_conclusions_error: null,
    };
  } catch (error) {
    return {
      final_conclusions: null,
      final_conclusions_error: {
        code: 'FINAL_CONCLUSIONS_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function readResearchOutcomeProjectionView(projectRoot: string, state: RunState): {
  research_outcome_projection: Record<string, unknown> | null;
  research_outcome_projection_error: Record<string, unknown> | null;
} {
  const pointer = readFinalConclusionsPointer(state);
  if (!pointer || !state.run_id) {
    return { research_outcome_projection: null, research_outcome_projection_error: null };
  }
  try {
    const filePath = resolveFinalConclusionsPath(projectRoot, pointer);
    if (!fs.existsSync(filePath)) {
      return {
        research_outcome_projection: null,
        research_outcome_projection_error: {
          code: 'RESEARCH_OUTCOME_PROJECTION_UNAVAILABLE',
          message: `Cannot build research outcome projection because final_conclusions_v1 is missing at ${pointer}.`,
        },
      };
    }

    const finalConclusions = assertFinalConclusionsValid(
      readJsonFile<unknown>(filePath, 'final_conclusions_v1.json'),
    ) as FinalConclusionsV1 & {
      objective_title?: string;
      source_result_summary?: string;
      produced_artifact_refs?: ArtifactRefV1[];
      verification_check_run_refs?: ArtifactRefV1[];
    };

    return {
      research_outcome_projection: {
        projection_status: 'partial',
        source_final_conclusions_path: pointer,
        source_final_conclusions_uri: makeScopedArtifactUri({
          scheme: 'orch',
          scope: 'runs',
          scopeId: state.run_id,
          artifactName: 'final_conclusions_v1.json',
        }),
        objective_title: finalConclusions.objective_title ?? null,
        summary: finalConclusions.summary,
        candidate_artifacts: finalConclusions.produced_artifact_refs ?? [],
        candidate_produced_by: {
          agent_id: finalConclusions.provenance.orchestrator_component,
          run_id: finalConclusions.run_id,
        },
        missing_for_research_outcome_v1: [
          'lineage_id',
          'strategy_ref',
          'metrics',
          'rdi_scores',
        ],
        reason: 'Local outcome seam is ready, but research_outcome_v1 remains deferred until strategy identity and richer outcome metrics are introduced.',
      },
      research_outcome_projection_error: null,
    };
  } catch (error) {
    return {
      research_outcome_projection: null,
      research_outcome_projection_error: {
        code: 'RESEARCH_OUTCOME_PROJECTION_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function handleOrchRunRequestFinalConclusions(
  params: z.output<typeof OrchRunRequestFinalConclusionsSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  if (state.run_id !== params.run_id) {
    throw invalidParams('Current orchestrator state does not match the requested run_id.', {
      state_run_id: state.run_id,
      requested_run_id: params.run_id,
    });
  }

  const satisfiedA5 = typeof state.gate_satisfied.A5 === 'string' ? state.gate_satisfied.A5 : null;
  if (satisfiedA5) {
    return {
      status: 'already_approved',
      ready_for_final_conclusions: true,
      gate_id: 'A5',
      gate_decision: 'pass',
      gate_summary: 'Final conclusions approval has already been satisfied for this run.',
      run_id: params.run_id,
      approval_id: satisfiedA5,
      uri: `orch://runs/${params.run_id}`,
      message: `A5 already satisfied: ${satisfiedA5}`,
    };
  }

  if (state.pending_approval && state.pending_approval.category !== 'A5') {
    throw invalidParams('Another pending approval must be resolved before requesting final conclusions.', {
      run_id: params.run_id,
      pending_approval_id: state.pending_approval.approval_id,
      pending_category: state.pending_approval.category,
    });
  }

  const pendingA5 = existingPendingA5(projectRoot, state, params.run_id);
  if (pendingA5) {
    return pendingA5;
  }

  const { gate, computationResult } = evaluateFinalConclusionsGate(projectRoot, params.run_id);
  if (gate.decision !== 'pass') {
    return {
      status: gate.decision === 'block' ? 'blocked' : gate.decision === 'hold' ? 'not_ready' : 'unavailable',
      ready_for_final_conclusions: false,
      gate_id: 'A5',
      gate_decision: gate.decision,
      gate_summary: gate.summary,
      run_id: params.run_id,
      uri: `orch://runs/${params.run_id}`,
      message: gate.decision === 'block'
        ? 'Final conclusions are blocked by current verification truth.'
        : 'Final conclusions are not ready yet.',
    };
  }

  const approvalPreviewId = `A5-${String((state.approval_seq.A5 ?? 0) + 1).padStart(4, '0')}`;
  const { computationResultPath } = loadComputationResult(projectRoot, params.run_id);
  const originalComputationResultText = fs.readFileSync(computationResultPath, 'utf-8');
  const packet = writeApprovalPacketArtifacts({
    projectRoot,
    state,
    runId: params.run_id,
    computationResult,
    gate,
    approvalId: approvalPreviewId,
  });
  const nextComputationResult = attachFinalConclusionsRequestToWorkspaceFeedback(computationResult, {
    approval_id: approvalPreviewId,
    gate_summary: gate.summary,
    packet_json_path: packet.packetJsonPath,
  });
  writeJsonAtomic(computationResultPath, assertComputationResultValid(nextComputationResult));
  let approvalId: string;
  try {
    const mutatedState = manager.readState();
    approvalId = manager.requestApproval(mutatedState, 'A5', {
      packet_path: packet.packetPath,
      ...(params.note ? { note: params.note } : {}),
      allow_completed: true,
    });
    if (approvalId !== approvalPreviewId) {
      throw invalidParams('approval_id drifted while creating A5 request', {
        expected: approvalPreviewId,
        actual: approvalId,
      });
    }
  } catch (error) {
    fs.writeFileSync(computationResultPath, originalComputationResultText, 'utf-8');
    fs.rmSync(path.dirname(path.join(projectRoot, packet.packetJsonPath)), { recursive: true, force: true });
    throw error;
  }
  return {
    status: 'requires_approval',
    requires_approval: true,
    gate_id: 'A5',
    gate_decision: gate.decision,
    gate_summary: gate.summary,
    run_id: params.run_id,
    approval_id: approvalId,
    approval_packet_sha256: packet.packetSha256,
    packet_path: packet.packetPath,
    packet_json_path: packet.packetJsonPath,
    uri: `orch://runs/${params.run_id}`,
    message: `Approval required: ${approvalId}`,
  };
}
